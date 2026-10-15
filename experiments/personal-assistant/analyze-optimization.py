"""Summarize a pinned validation run and explicitly recorded semantic review."""
import argparse
import collections
import json
import statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory")
args = parser.parse_args()
root = Path(args.directory)
records = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines()]
accounting = {row["id"]: row for row in json.loads((root / "accounting.json").read_text())}
review = json.loads((root / "review.json").read_text())
grades = {row["id"]: row for row in review["checks"]}
if len(records) != 66 or len(grades) != 66 or set(grades) != {r["id"] for r in records}:
    raise RuntimeError("Expected all 66 records and explicit review of each")
summary = {"records": len(records), "hostCalls": 84, "groups": {}, "caseResults": {}, "reflection": {}}
for kind in ["task", "reflection-transfer"]:
    for arm in ["legacy", "optimized"]:
        rows = [r for r in records if r["kind"] == kind and r["arm"] == arm]
        comparable = [r for r in rows if r["case"] != "product-missing-update"]
        duration = [r["first"]["wallTimeMs"] for r in rows]
        summary["groups"][f"{kind}/{arm}"] = {
            "records": len(rows), "comparable": len(comparable),
            "behavior": dict(collections.Counter(grades[r["id"]]["status"] for r in comparable)),
            "qualityNotes": sum(bool(grades[r["id"]].get("qualityNotes")) for r in rows),
            "nativeCostUsd": sum(accounting[r["id"]]["cost"] for r in rows),
            "firstAnswerMedianMs": statistics.median(duration),
            "firstAnswerMeanMs": statistics.mean(duration),
            "answerMeanChars": statistics.mean(len(r["first"]["text"]) for r in rows),
            "errors": sum(r["first"]["reason"] != "done" for r in rows),
            "rawToolSyntax": sum("<｜DSML｜" in r["first"]["text"] or "<|DSML|" in r["first"]["text"] for r in rows),
        }
    for case in sorted({r["case"] for r in records if r["kind"] == kind}):
        summary["caseResults"][f"{kind}/{case}"] = {
            arm: dict(collections.Counter(grades[r["id"]]["status"] for r in records if r["kind"] == kind and r["case"] == case and r["arm"] == arm))
            for arm in ["legacy", "optimized"]
        }
for arm in ["legacy", "optimized"]:
    rows = [r for r in records if r["kind"] == "reflection-transfer" and r["arm"] == arm]
    summary["reflection"][arm] = {
        "runs": len(rows), "nonemptyRuns": sum(bool(r["learned"]) for r in rows),
        "memories": sum(len(r["learned"]) for r in rows),
        "validProvenance": sum(all(e.get("evidenceIds") and set(e["evidenceIds"]) <= {i["id"] for i in r["interactions"]} for e in r["learned"]) for r in rows if r["learned"]),
        "extractionReview": dict(collections.Counter(grades[r["id"]].get("extractionStatus", "unreviewed") for r in rows)),
        "scopedOrUnsupportedMemoryNotes": [ {"id":r["id"], "notes":grades[r["id"]]["extractionNotes"]} for r in rows if grades[r["id"]].get("extractionNotes") ],
    }
summary["nativeCostUsd"] = sum(row["cost"] for row in accounting.values())
summary["engineVersions"] = sorted({s["engineVersion"] for row in accounting.values() for s in row["sessions"]})
summary["accountingDiscrepancies"] = sum(not row["acpCostMatchesSessionTotal"] for row in accounting.values())
summary["limitations"] = review["limitations"]
(root / "analysis.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
