"""Freeze a deterministic diagnostic cohort from saved prior errors, before inference.

Uses category and output-shape strata only; does not choose by future performance.
No question, answer, or gold evidence enters this plan.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / ".mentat/public-evaluations"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
sources = [BASE / "longmemeval-s-full-v1/results.jsonl",
           BASE / "longmemeval-s-judge-recovery-v1/recoveries.json",
           BASE / "longmemeval-s-reader-recovery-v1/recoveries.json"]
rows = {(r["question_id"], r["agent"]): r for line in sources[0].read_text().splitlines()
        if (r := json.loads(line))}
for path in sources[1:]:
    for item in json.loads(path.read_text())["items"]:
        replacement = item["replacement"]
        rows[replacement["question_id"], replacement["agent"]] = replacement
errors = [r for r in rows.values() if r["agent"] == "mentat-episodic" and r["correct"] is False]
quotas = {"multi-session": (8, 6), "temporal-reasoning": (8, 6),
          "single-session-preference": (4, 2), "single-session-user": (4, 2),
          "single-session-assistant": (2, 2), "knowledge-update": (4, 2)}
seed = "mentat-longmemeval-prior-error50-v1"
selected = []
for category, counts in quotas.items():
    for dsml, count in zip([True, False], counts):
        pool = [r for r in errors if r["question_type"] == category and
                ("DSML" in r.get("hypothesis", "")) == dsml]
        # Include rejection cases when available within each fixed stratum.
        pool.sort(key=lambda r: (not r["question_id"].endswith("_abs"),
                                hashlib.sha256((seed + r["question_id"]).encode()).hexdigest()))
        assert len(pool) >= count, (category, dsml, len(pool), count)
        selected.extend({"questionId": r["question_id"], "questionType": category,
                         "priorCorrect": False, "priorDsml": dsml,
                         "abstention": r["question_id"].endswith("_abs"),
                         "priorHypothesisSha256": hashlib.sha256(r["hypothesis"].encode()).hexdigest()}
                        for r in pool[:count])
selected.sort(key=lambda r: hashlib.sha256((seed + r["questionId"]).encode()).hexdigest())
assert len(selected) == len({r["questionId"] for r in selected}) == 50
plan = {"schemaVersion": 1, "kind": "fixed-prior-error-diagnostic", "seed": seed,
        "selection": "50 prior Mentat errors, 30 with DSML text and20 without; fixed category quotas; prioritize abstention within each stratum; SHA256 deterministic order",
        "claimBoundary": "Post-hoc error cohort; no full-dataset accuracy or unbiased improvement estimate. Original results immutable. Exactly one inference per selected question; no answer resampling.",
        "sources": [{"path": str(p.relative_to(ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sources],
        "byType": dict(Counter(r["questionType"] for r in selected)),
        "abstentionCount": sum(r["abstention"] for r in selected), "items": selected}
args.out.parent.mkdir(parents=True, exist_ok=True)
with args.out.open("x") as stream:
    json.dump(plan, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
print(json.dumps({"selected": len(selected), "byType": plan["byType"], "abstention": plan["abstentionCount"], "out": str(args.out)}))
