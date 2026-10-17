"""Analyze a frozen prior-error cohort; never present it as full benchmark accuracy."""
import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

from audit_text_transport import audit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run", type=Path, required=True)
parser.add_argument("--transport", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
manifest = json.loads((args.run / "manifest.json").read_text())
assert manifest["scope"] == "fixed-prior-error50-diagnostic"
plan = manifest["selection"]["plan"]
rows = [json.loads(line) for line in (args.run / "results.jsonl").read_text().splitlines()]
assert manifest["agents"] == ["mentat-episodic"]
assert len(rows) == 50 and len({r["question_id"] for r in rows}) == 50
assert {r["question_id"] for r in rows} == {r["questionId"] for r in plan["items"]}
assert all(not r["priorCorrect"] for r in plan["items"])
known = [r for r in rows if r["status"] == "completed"]
def summarize(group):
    valid = [r for r in group if r["status"] == "completed"]
    return {"planned": len(group), "scored": len(valid),
            "correct": sum(r["correct"] for r in valid),
            "usableCorrect": sum(r.get("usableCorrect", False) for r in valid),
            "dsmlText": sum("DSML" in r.get("hypothesis", "") for r in group),
            "invalidFinalAnswer": sum(not r.get("finalAnswerValid", False) for r in valid),
            "infrastructureErrors": len(group) - len(valid)}
coverage = [r["supportSessionRecall"] for r in known if r.get("supportSessionRecall") is not None]
token_counts = []
for row in known:
    response = json.loads(Path(row["evidence"][0]).read_text())
    sessions = response["observations"]["accounting"]["sessions"]
    if sessions and all(isinstance(s.get("tokens_input"), (float, int)) for s in sessions):
        token_counts.append(sum(s["tokens_input"] for s in sessions))
result = {"scope": manifest["scope"], "claimBoundary": plan["claimBoundary"],
          "subject": manifest["transport"], "before": {"correct": 0, "planned": 50,
          "dsmlText": sum(r["priorDsml"] for r in plan["items"])},
          "after": summarize(rows),
          "byType": {t: summarize([r for r in rows if r["question_type"] == t]) for t in sorted({r["question_type"] for r in rows})},
          "byPriorOutput": {name: summarize([r for r in rows if r["question_id"] in
              {x["questionId"] for x in plan["items"] if x["priorDsml"] == flag}]) for name,flag in [("dsml",True),("normal",False)]},
          "abstention": summarize([r for r in rows if r["question_id"].endswith("_abs")]),
          "supportCoverage": {"measured": len(coverage), "meanSessionRecall": statistics.mean(coverage) if coverage else None,
                              "allSupportSessionsRetrieved": sum(r.get("allSupportSessionsRetrieved") is True for r in known),
                              "limitation": "Session hit only; does not establish that the selected message contains the supporting fact. Gold labels used only by controller after answer."},
          "meanReaderInputTokens": statistics.mean(token_counts) if token_counts else None,
          "readerTokenCoverage": len(token_counts),
          "costUsdKnown": sum(r.get("costUsd") or 0 for r in rows),
          "unknownCostRows": sum(r.get("costUsd") is None for r in rows),
          "medianReaderAndJudgeMs": statistics.median(r["durationMs"] for r in known) if known else None,
          "toolAudit": audit(args.transport),
          "resultsSha256": hashlib.sha256((args.run / "results.jsonl").read_bytes()).hexdigest()}
args.out.parent.mkdir(parents=True, exist_ok=True)
with args.out.open("x") as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
print(json.dumps({"after": result["after"], "byType": result["byType"], "abstention": result["abstention"]}))
