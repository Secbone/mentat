"""Pre-registered paired experience-retention acceptance, with reset kept separate."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean

from compare_foundation import read_rows, stats


def compare(run):
    plan, reset_roster, reset_rows = read_rows(run, "reset")
    _, retained_roster, retained_rows = read_rows(run, "memory")
    assert plan["pairedResetEvaluationOnly"] and plan["nativeSkillSnapshots"]
    assert plan["primaryAcceptance"] == {"bucket": "evaluation", "scoreArm": "memory", "baselineArm": "reset", "minimumScore100": 50, "gain": "strictly positive", "nativeReuseRequired": True}
    expected = {"memory_ability/SM01_preference_adoption", "memory_ability/SM02_constraint_retention", "procedural_ability/PC03_latent_rule_induction_01", "procedural_ability/PC04_failure_to_rule_01"}
    assert len(reset_roster) == 8 and len(retained_roster) == 32
    assert {r["family"] for r in reset_rows} == expected
    evaluations = [r for r in retained_rows if r["bucket"] == "evaluation"]
    assert {(r["family"], r["taskId"]) for r in evaluations} == reset_roster
    assert all(sum(r["family"] == f for r in reset_rows) == 2 for f in expected)
    baseline = stats(reset_roster, reset_rows)
    retained = stats(retained_roster, retained_rows)
    audit = json.loads((run / "audit.json").read_text())
    assert audit["status"] == "passed" and audit["skillTransitionsChecked"] == 40
    reset_scores = {r["taskId"]: r["task_score"] if r["status"] == "completed" else 0 for r in reset_rows}
    reused = {r["taskId"] for r in audit["inheritedProcedureReadCases"] if r["arm"] == "memory" and any(read["completedBeforeBusinessWrite"] for read in r["reads"])}
    improved_reuse = [r["taskId"] for r in evaluations if r["status"] == "completed" and r["taskId"] in reused and r.get("retrieval_signals", {}).get("used_expected_signal") and r["task_score"] > reset_scores[r["taskId"]]]
    gain = retained["evaluationMean100"] - baseline["evaluationMean100"]
    gates = {"retainedTransferAtLeast50": retained["evaluationMean100"] >= 50, "positiveMatchedTransferGain": gain > 0, "verifiedInheritedProcedureReuseWithImprovement": bool(improved_reuse), "fullRosterAndAudit": True}
    return {"protocol": "paired-foundation-experience-acceptance-v1", "model": plan["model"], "runDirectory": str(run),
        "planSha256": hashlib.sha256((run / "plan.json").read_bytes()).hexdigest(),
        "acceptancePassed": all(gates.values()), "gates": gates, "reset": baseline, "retained": retained,
        "transferGain100": gain, "verifiedImprovedReuseCases": improved_reuse,
        "retainedBucketMeans100": {bucket: 100 * mean(r["task_score"] if r["status"] == "completed" else 0 for r in retained_rows if r["bucket"] == bucket) for bucket in sorted({r["bucket"] for r in retained_rows})},
        "audit": audit,
        "limits": ["Adapted fixed 4 families / 2 capabilities, not official full PAST Overall", "This measures experience-based adaptation and transfer, not autonomous code evolution", "Single run and previously inspected development tasks; no blind-test or statistical reliability claim", "Reset and retained scores reported separately, never merged or selectively replaced", "Same frozen source/model/grader/budgets, no communication judge, failures retained", "Learning/control costs included in retained total; transfer gain is not cost-normalized"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = compare(args.run)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"acceptancePassed": result["acceptancePassed"], "gates": result["gates"], "resetTransfer100": result["reset"]["evaluationMean100"], "retainedTransfer100": result["retained"]["evaluationMean100"], "transferGain100": result["transferGain100"], "verifiedImprovedReuseCases": result["verifiedImprovedReuseCases"]}, ensure_ascii=False, indent=2))
