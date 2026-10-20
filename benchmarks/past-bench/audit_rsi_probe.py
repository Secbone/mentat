"""Check frozen inputs, real dispatch receipts, model identity and fresh sessions."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys


def audit(run):
    root = Path(__file__).resolve().parents[2]
    upstream = root / ".mentat/upstream/past-bench"
    plan = json.loads((run / "plan.json").read_text())
    sys.path.insert(0, str(upstream / "src"))
    from past_bench.models.task import TaskDefinition
    roster = {(r["family"], r["arm"], r["index"]): r for r in plan["roster"]}
    errors, session_ids, row_count, dispatch_count, frame_count = [], set(), 0, 0, 0
    unscored, analysis_changes, pre_dispatch_failures = [], [], []
    source = json.loads((run / "subject-source.json").read_text())
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    corrected = "corrective1" in plan["protocol"]
    subject_path = root / (".mentat/past-rsi-turn-corrected.ts" if corrected else "scripts/past-rsi-turn.ts")
    runner_path = root / (".mentat/past-rsi-corrected.py" if corrected else "benchmarks/past-bench/rsi_probe.py")
    if sha(subject_path) != plan["subjectSha256"] or sha(runner_path) != plan["runnerSha256"]:
        errors.append("running subject/runner source digest changed")
    if sha(run / "subject-source.json") != plan["subjectArchiveSha256"]:
        errors.append("source archive digest mismatch")
    for item in source:
        path = root / item["name"]
        if not path.is_file() or sha(path) != item["sha256"]:
            # This standalone post-run analyzer is not imported by either
            # subject or controller. Retain its drift, never waive runtime drift.
            if item["name"] == "benchmarks/past-bench/analyze_rsi_probe.py":
                analysis_changes.append(item["name"])
            else:
                errors.append(f"frozen execution source changed: {item['name']}")
    for field in ["datasetHashes", "upstreamScorerSourceHashes"]:
        for name, expected in plan[field].items():
            path = upstream / name
            if not path.is_file() or sha(path) != expected:
                errors.append(f"frozen upstream changed: {name}")
    for row in [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]:
        if row["status"] != "completed":
            unscored.append({"taskId": row["taskId"], "arm": row["arm"], "reason": row.get("error")})
        else:
            row_count += 1
        trial = run / "trials" / row["family"].split("/")[-1] / row["arm"] / f"{row['index']:02d}"
        config = json.loads((trial / "controller.json").read_text())
        episode = roster[(row["family"], row["arm"], row["index"])]["episode"]
        task_path = Path(episode["task"])
        task = TaskDefinition.from_yaml(task_path / "task.yaml" if task_path.is_dir() else task_path)
        if config["query"] != task.prompt.text:
            errors.append(f"model query differs from original task prompt: {trial}")
        catalog = json.loads((trial / "tools.json").read_text())
        expected_catalog = [{"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in task.tools]
        if catalog != expected_catalog:
            errors.append(f"model tool schemas differ from task allowlist: {trial}")
        if set(config) != {"socketPath", "token", "toolsPath", "query", "stateDir", "scope", "reflect", "timeoutMs", "maxSteps"}:
            errors.append(f"non-allowlisted controller fields: {trial}")
        response_path = trial / "subject/response.json"
        if not response_path.exists():
            errors.append(f"missing subject evidence: {trial}")
            continue
        response = json.loads(response_path.read_text())
        tools = {t["name"] for t in catalog}
        names = [c["name"] for c in response["calls"]]
        allowed = {f"environment_{n}" for n in tools} | {"direct_memory_memory_add", "direct_memory_memory_search", "direct_memory_memory_ready"}
        if set(names) - allowed:
            errors.append(f"tool outside allowlist: {trial}")
        actual = Counter(n.removeprefix("environment_") for n in names if n.startswith("environment_"))
        trace = [json.loads(line) for line in (trial / "upstream-trace.jsonl").read_text().splitlines()]
        receipts = Counter(e["tool_name"] for e in trace if e["type"] == "tool_dispatch")
        missing_receipts = actual - receipts
        failed_calls = Counter(c["name"].removeprefix("environment_") for c in response["calls"] if c["name"].startswith("environment_") and c["status"] == "failed")
        if receipts - actual or missing_receipts - failed_calls:
            errors.append(f"native calls vs upstream receipts mismatch: {trial}: {actual} != {receipts}")
        elif missing_receipts:
            pre_dispatch_failures.append({"taskId": row["taskId"], "arm": row["arm"], "calls": dict(missing_receipts), "meaning": "native failed calls without upstream execution receipt; never counted as dispatched"})
        dispatch_count += sum(receipts.values())
        obs = response["observations"]
        if not obs["models"] or any(m.get("effective") != plan["model"] for m in obs["models"]):
            errors.append(f"model mismatch: {trial}")
        for sid in obs["nativeSessionIds"]:
            if sid in session_ids:
                errors.append(f"engine session reused: {trial}")
            session_ids.add(sid)
        if obs["accounting"]["status"] != "complete":
            errors.append(f"incomplete native accounting: {trial}")
        before = json.loads((trial / "subject/memory-before.json").read_text())["entries"]
        if row["arm"] != "reset" and episode["persistence_allowed"] and episode["history_mode"] == "from_anchor":
            anchor = run / "state" / row["family"].split("/")[-1] / row["arm"] / "anchors" / episode["history_load_anchor"] / "memory.json"
            seed = json.loads(anchor.read_text()) if anchor.exists() else []
            expected_entries = seed if isinstance(seed, list) else seed.get("entries", [])
            if before != expected_entries:
                errors.append(f"anchor restoration mismatch: {trial}")
        if row["arm"] == "reset" and before:
            errors.append(f"reset arm retained memory: {trial}")
        if any(e.get("status", "active") == "active" for e in before):
            errors.append(f"unexpected activation requires review: {trial}")
        for trace_path in (trial / "subject/trace").glob("*/events.jsonl"):
            for line in trace_path.read_text().splitlines():
                event = json.loads(line)
                if event["type"] == "adapter.protocol":
                    frame_count += 1
                if event["type"] == "capture.gap":
                    errors.append(f"capture gap: {trial}")
    return {"status": "passed" if not errors else "failed", "scoredTrials": row_count, "unscoredTrials": unscored,
            "changedAnalysisFiles": analysis_changes, "preDispatchFailures": pre_dispatch_failures,
            "nativeSessions": len(session_ids), "environmentDispatchReceipts": dispatch_count,
            "protocolFrames": frame_count, "issues": errors,
            "coverage": "Frozen file hashes, allowlisted controller fields and tools, native tool calls versus real upstream dispatch receipts, effective model, fresh engine sessions, accounting completeness and empty reset memory. Not OS isolation or training contamination proof."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.run)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["status"] == "passed" else 1)
