"""Offline, roster-aware summaries; never sends scores or labels to the subject."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from statistics import mean, median


def analyze(run):
    plan = json.loads((run / "plan.json").read_text())
    rows = [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]
    # Reconcile evidence for a budget failure without inventing an upstream score.
    for row in rows:
        if row["status"] == "completed":
            continue
        trial = run / "trials" / row["family"].split("/")[-1] / row["arm"] / f"{row['index']:02d}"
        response_path = trial / "subject/response.json"
        if response_path.exists():
            response = json.loads(response_path.read_text())
            row.update(costUsd=response["observations"]["costUsd"], nativeCalls=response["calls"], nativeMemory=response["observations"]["memory"],
                       validFinalAnswer=False, firstAnswerValid=False, correctiveTurns=response.get("correctiveTurns", 0), reflection=response.get("reflection"))
            row["tool_dispatch_count"] = sum(json.loads(line)["type"] == "tool_dispatch" for line in (trial / "upstream-trace.jsonl").read_text().splitlines())
    key = lambda row: (row["family"], row["arm"], row["index"])
    expected = {key(row): row for row in plan["roster"]}
    assert len(expected) == len(plan["roster"])
    found = {key(row): row for row in rows}
    assert len(found) == len(rows) and set(found) <= set(expected), "duplicate or unplanned result"
    groups, paired = {}, {}
    evolution_events = Counter()
    for trace in (run / "trials").glob("*/*/*/subject/trace/*/events.jsonl"):
        for line in trace.read_text().splitlines():
            event = json.loads(line)
            if event["type"].startswith(("loop.", "proposal.", "iteration.", "workspace.commit.")):
                evolution_events[event["type"]] += 1
    for arm in sorted({row["arm"] for row in plan["roster"]}):
        planned = [r for r in plan["roster"] if r["arm"] == arm]
        actual = [r for r in rows if r["arm"] == arm]
        scored = [r for r in actual if r["status"] == "completed"]
        evaluation = [r for r in scored if r["bucket"] == "evaluation"]
        learning = [r for r in scored if r["bucket"] not in {"baseline", "evaluation", "control"}]
        by_family = {}
        for family in sorted({r["family"] for r in planned}):
            subset = [r for r in evaluation if r["family"] == family]
            by_family[family] = {
                "scored": len(subset), "passed": sum(r["passed"] for r in subset),
                "meanScore": mean(r["task_score"] for r in subset) if subset else None,
                "valid": sum(r["validFinalAnswer"] for r in subset),
            }
        costs = [r.get("costUsd") for r in actual]
        calls = Counter(c["name"] for r in actual for c in r.get("nativeCalls", []))
        reflections = [r["reflection"] for r in scored if r.get("reflection") is not None]
        groups[arm] = {
            "planned": len(planned), "recorded": len(actual), "scored": len(scored),
            "missing": len(planned) - len(actual),
            "budgetFailures": sum(r["status"] == "error" and "turn timed out" in r.get("error", "") for r in actual),
            "infraErrors": sum(r["status"] == "error" and "turn timed out" not in r.get("error", "") for r in actual),
            "validAnswers": sum(r["validFinalAnswer"] for r in scored),
            "firstAnswerValid": sum(r.get("firstAnswerValid", r["validFinalAnswer"]) for r in scored),
            "correctiveTurns": sum(r.get("correctiveTurns", 0) for r in actual),
            "usablePassed": sum(r["passed"] and r["validFinalAnswer"] for r in scored),
            "invalidAnswerReasons": dict(Counter(r.get("answerError") for r in scored if not r["validFinalAnswer"])),
            "evaluation": {"planned": sum(r["episode"]["bucket"] == "evaluation" for r in planned),
                           "scored": len(evaluation), "passed": sum(r["passed"] for r in evaluation),
                           "meanScore": mean(r["task_score"] for r in evaluation) if evaluation else None,
                           "families": by_family},
            "nativeCalls": dict(calls), "environmentDispatches": sum(r.get("tool_dispatch_count", 0) for r in actual),
            "memoryAddAttempts": calls["direct_memory_memory_add"],
            "memorySearchAttempts": calls["direct_memory_memory_search"],
            "evaluationInjectedEntries": sum(r["nativeMemory"]["injectedEntries"] for r in evaluation),
            "learningMaxActiveAfter": max((r["activeAfter"] for r in learning), default=0),
            "learningMaxCandidatesAfter": max((r["candidateAfter"] for r in learning), default=0),
            "reflectionAttempts": len(reflections),
            "reflectionStatuses": dict(Counter(r.get("status") for r in reflections)),
            "reflectionAdded": sum(r.get("added", 0) for r in reflections),
            "reflectionRejected": sum(r.get("rejected", 0) for r in reflections),
            "costCoverage": sum(isinstance(c, (float, int)) for c in costs),
            "recordedCostUsd": sum(c for c in costs if isinstance(c, (float, int))),
            "medianWallSeconds": median(r["timing"]["wall_time_s"] for r in scored) if scored else None,
        }
    for baseline, treatment in [("reset", "memory"), ("memory", "reflect")]:
        pairs = []
        for row in rows:
            if row["arm"] != baseline or row.get("bucket") != "evaluation" or row["status"] != "completed":
                continue
            other = found.get((row["family"], treatment, row["index"]))
            if other and other["status"] == "completed":
                pairs.append({"family": row["family"], "taskId": row["taskId"], "baselineScore": row["task_score"],
                              "treatmentScore": other["task_score"], "delta": other["task_score"] - row["task_score"],
                              "baselinePassed": row["passed"], "treatmentPassed": other["passed"]})
        paired[f"{baseline}-to-{treatment}"] = {"pairs": pairs, "meanScoreDelta": mean(p["delta"] for p in pairs) if pairs else None}
    root = Path(__file__).resolve().parents[2]
    archive = json.loads((run / "subject-source.json").read_text())
    changed = [r["name"] for r in archive if not (root / r["name"]).exists() or hashlib.sha256((root / r["name"]).read_bytes()).hexdigest() != r["sha256"]]
    return {"protocol": plan["protocol"], "track": plan["track"], "model": plan["model"], "revision": plan["revision"],
            "upstreamRevision": plan["upstreamRevision"], "scope": plan["scope"],
            "planned": len(expected), "recorded": len(rows), "missing": len(expected) - len(found),
            "groups": groups, "paired": paired, "frozenSourceChanged": changed,
            "unsupportedFamilies": plan["unsupportedFamilies"], "limits": plan["limits"],
            "recursiveSelfImprovement": {"observedEvolutionEvents": dict(evolution_events),
                                         "materializedCandidates": evolution_events["iteration.apply"],
                                         "committedCandidates": evolution_events["workspace.commit.end"],
                                         "loopRuns": evolution_events["loop.start"],
                                         "interpretation": "native assistant/reflection path does not invoke a verified mechanism evolution loop; absence of events is a protocol capability boundary, not an estimate of a hidden process"},
            "cases": [{k: r.get(k) for k in ["family", "arm", "index", "taskId", "bucket", "stage", "status", "task_score", "passed", "validFinalAnswer", "answerError", "activeBefore", "activeAfter", "candidateAfter", "costUsd", "tool_dispatch_count"]} for r in rows]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(args.run)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"planned": result["planned"], "recorded": result["recorded"], "missing": result["missing"], "groups": result["groups"]}, ensure_ascii=False, indent=2))
