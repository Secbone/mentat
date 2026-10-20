"""Continue only unattempted roster entries after a task budget timeout.

No completed/failed trial is retried or replaced. The frozen subject, task
manifests, timeout, state anchors, dispatcher and grader remain unchanged.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

import rsi_probe as probe


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    plan = json.loads((run / "plan.json").read_text())
    assert probe.digest(Path(probe.__file__)) == plan["runnerSha256"]
    assert probe.digest(probe.ROOT / "scripts/past-rsi-turn.ts") == plan["subjectSha256"]
    for field in ["datasetHashes", "upstreamScorerSourceHashes"]:
        for name, digest in plan[field].items():
            assert probe.digest(probe.UPSTREAM / name) == digest, name
    rows = [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]
    key = lambda row: (row["family"], row["arm"], row["index"])
    attempted = {key(row) for row in rows}
    assert len(attempted) == len(rows)
    assert all(row["status"] == "completed" or "turn timed out" in row.get("error", "") for row in rows), "only known task-budget interruptions may continue"
    remaining = [r for r in plan["roster"] if key(r) not in attempted]
    # Match original family -> arm -> episode scheduling, not interleaved roster order.
    family_order = list(dict.fromkeys(r["family"] for r in plan["roster"]))
    arm_order = list(plan["arms"])
    remaining.sort(key=lambda r: (family_order.index(r["family"]), arm_order.index(r["arm"]), r["index"]))
    probe.write(run / f"resume-{len(rows):03d}.json", {"runnerSha256": probe.digest(Path(__file__)), "reason": "task budget timeout; no retry of attempted tasks", "remaining": remaining})
    backend = probe.PersistenceBackend()
    seen_groups = set()
    for item in remaining:
        family, arm, index = item["family"], item["arm"], item["index"]
        sequence = probe.SelfEvolveSequenceDefinition.from_yaml(run / "manifests" / f"{Path(family).name}.yaml")
        episode = sequence.episodes[index]
        state = run / "state" / Path(family).name / arm / "current"
        anchors = state.parent / "anchors"
        known = {p.name: p for p in anchors.iterdir() if p.is_dir()} if anchors.exists() else {}
        group = (family, arm)
        if group not in seen_groups and not any(r["family"] == family and r["arm"] == arm for r in rows):
            backend.reset_state(state)
        seen_groups.add(group)
        if arm == "reset" or not episode.persistence_allowed:
            backend.reset_state(state)
        else:
            backend.prepare_history(state_root=state, episode=episode, history_anchors=known)
        path = Path(episode.task)
        task = probe.TaskDefinition.from_yaml(path / "task.yaml" if path.is_dir() else path)
        out = run / "trials" / Path(family).name / arm / f"{index:02d}"
        assert not out.exists(), "never retry or overwrite an attempted trial"
        record = {"family": family, "arm": arm, "index": index, "taskId": task.task_id, "bucket": episode.bucket, "stage": episode.stage, "transferDistance": episode.transfer_distance}
        print(f"START remaining {family} {arm} {index + 1}", flush=True)
        try:
            record.update(probe.run_episode(task, episode, arm, state, out, plan["timeoutSeconds"], plan["portOffset"]))
        except Exception as error:
            record.update(status="error", error=str(error), passed=None, task_score=None)
        backend.save_anchor(state_root=state, episode=episode, anchors_dir=anchors, history_anchors=known)
        rows.append(record)
        with (run / "results.jsonl").open("a") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        probe.write(out / "result.json", record)
        probe.write(run / "progress.json", {"completed": len(rows), "planned": len(plan["roster"]), "statuses": dict(Counter(r["status"] for r in rows))})
        print(f"END {arm} {task.task_id} {record['status']} score={record.get('task_score')}", flush=True)
        if record["status"] == "error" and "turn timed out" not in record["error"]:
            return 2
    assert len({key(r) for r in rows}) == len(plan["roster"])
    probe.write(run / "complete.json", {"status": "completed-with-budget-failures" if any(r["status"] == "error" for r in rows) else "completed", "recorded": len(rows), "planned": len(plan["roster"])})
    return 0


if __name__ == "__main__":
    sys.exit(main())
