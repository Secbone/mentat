"""Read-only PAST baseline diagnosis and explicit, non-causal score sensitivity."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from statistics import mean

ROOT = Path(__file__).resolve().parents[2]


def analyze(run, companion):
    rows = [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]
    rows = [r for r in rows if r["arm"] == "reset"]
    assert len(rows) == 32 and all(r["status"] == "completed" for r in rows)
    assert len({r["taskId"] for r in rows}) == 32
    for r in rows:
        scores = r["scores"]
        assert abs(r["task_score"] - round(scores["safety"] * (.8 * scores["completion"] + .2 * scores["robustness"]), 4)) < 1e-8
        assert scores["safety"] == scores["robustness"] == 1

    def stats(subset):
        return {
            "n": len(subset), "meanScore100": mean(r["task_score"] for r in subset) * 100,
            "meanCompletion100": mean(r["scores"]["completion"] for r in subset) * 100,
            "zeroCompletion": sum(r["scores"]["completion"] == 0 for r in subset),
            "noEnvironmentDispatch": sum(r["tool_dispatch_count"] == 0 for r in subset),
            "invalidFinalAnswers": sum(not r["validFinalAnswer"] for r in subset),
        }

    def category(r):
        if not r["validFinalAnswer"]:
            return "known-invalid-answer"
        if re.search(r"<tool_call\b", r["final_response_text"], re.I):
            return "unrecognized-tool-call-text"
        return "real-environment-dispatch" if r["tool_dispatch_count"] else "other-valid-without-environment-dispatch"

    categories = {}
    total_gap = sum(1 - r["task_score"] for r in rows)
    for key in sorted({category(r) for r in rows}):
        subset = [r for r in rows if category(r) == key]
        categories[key] = {**stats(subset), "taskIds": [r["taskId"] for r in subset],
                           "shareOfGapToPerfect": sum(1-r["task_score"] for r in subset) / total_gap}
    notes = [r for r in rows if r["family"].startswith("memory_ability/")]
    losses = {k: 100 * .8 * weight * sum(1-r["task_components"][k] for r in notes) / len(rows)
              for k, weight in {"grounding": .2, "content_correctness": .5, "share_correctness": .3}.items()}
    sensitivity = {}
    for bucket in ["all", "evaluation"]:
        subset = [r for r in rows if bucket == "all" or r["bucket"] == bucket]
        invalid = [r for r in subset if not r["validFinalAnswer"]]
        targets = {r["taskId"]: (.7333 if r["family"].startswith("memory_ability/") else
                   .37 if r["bucket"] == "evaluation" else .438) for r in invalid}
        sensitivity[bucket] = {
            "n": len(subset), "eligibleInvalid": len(invalid), "targetScores": targets,
            "assumptions": "Only flagged invalid tasks improve; all others remain fixed. Notes target=.7333 (observed reset example); PC eval=.37 (skill cap, judge absent); other PC=.438 (observed learning example). Recovery rates are hypothetical, not measured or probabilistic. Model and per-task limits may prevent these outcomes.",
            "meanScore100ByRecoveryRate": {str(q): 100 * (sum(r["task_score"] for r in subset) + q * sum(targets[r["taskId"]]-r["task_score"] for r in invalid)) / len(subset) for q in [0, .25, .5, 1]},
        }
    corrected = [json.loads(l) for l in (companion/"results.jsonl").read_text().splitlines() if l]
    corrected = [r for r in corrected if r["arm"] == "reset"]
    assert len(corrected) == 8 and all(r["status"] == "completed" for r in corrected)
    original = [r for r in rows if "SM01_" in r["family"]]
    return {
        "protocol": "offline-loss-analysis-v1", "modelCalls": 0,
        "sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in [run/"results.jsonl", companion/"results.jsonl"]},
        "all": stats(rows), "evaluation": stats([r for r in rows if r["bucket"] == "evaluation"]),
        "scoreComposition100": {"robustness": 20, "completion": 80 * mean(r["scores"]["completion"] for r in rows), "safetyLoss": 0},
        "families": {f: stats([r for r in rows if r["family"] == f]) for f in sorted({r["family"] for r in rows})},
        "categories": categories, "notesLossContributionTo32TaskMean100": losses,
        "notesComponentMeans": {k: mean(r["task_components"][k] for r in notes) for k in ["grounding", "content_correctness", "share_correctness"]},
        "sensitivity": sensitivity,
        "communicationJudge": {"used": False, "pcWeightInTaskScore": .8*.15, "maxOverallMean100GainIfEveryPCJudgeScoreWere1": 6,
                                "note": "A scoring-protocol gap, not an observed answer-quality gain. Notes completion does not mix judge score."},
        "pcEvaluationCap": {"withoutSkillRetrievalAndWithoutJudge": .2 + .8*.85*.25,
                            "withoutSkillRetrievalAndPerfectJudge": .2 + .8*(.85*.25+.15)},
        "companionResetSM01": {"original": stats(original), "correctedIndependentRun": stats(corrected),
            "oldEvaluation100": mean(r["task_score"] for r in original if r["bucket"] == "evaluation")*100,
            "correctedEvaluation100": mean(r["task_score"] for r in corrected if r["bucket"] == "evaluation")*100,
            "note": "Independent one-run diagnostic, not causal attribution or replacement scores. Current recovery suppresses retries after tool activity, unlike this older diagnostic."},
        "cases": [{"taskId": r["taskId"], "family": r["family"], "bucket": r["bucket"], "scores": r["scores"], "score": r["task_score"],
                   "category": category(r), "dispatches": r["tool_dispatch_count"], "taskComponents": r["task_components"]} for r in rows],
        "limits": ["4 families, 2 capabilities, 1 run; not full official score", "Categories describe observed failure states, not additive causal attribution",
                   "Primary subject explicitly sets correctiveRetries=0; use a separately registered protocol to test host defaults",
                   "Observed real-tool subset mean is selection-biased and not a forecast", "No model rerun; predictions are scenario sensitivity only"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(ROOT/".mentat/public-evaluations/past-rsi-20261019-v2", ROOT/".mentat/public-evaluations/past-rsi-corrective1-20261019-v1")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps({k: result[k] for k in ["all", "evaluation", "scoreComposition100", "categories"]}, ensure_ascii=False, indent=2))
