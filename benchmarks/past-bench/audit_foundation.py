"""Check frozen inputs, real dispatch receipts, model identity and fresh sessions."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
from skill_lineage import inherited_reads, validate_transition
from native_recall_audit import check_selection, identity, read_records


def audit(run):
    root = Path(__file__).resolve().parents[2]
    upstream = root / ".mentat/upstream/past-bench"
    plan = json.loads((run / "plan.json").read_text())
    sys.path.insert(0, str(upstream / "src"))
    from past_bench.models.task import TaskDefinition
    roster = {(r["family"], r["arm"], r["index"]): r for r in plan["roster"]}
    errors, session_ids, row_count, dispatch_count, frame_count = [], set(), 0, 0, 0
    unscored, analysis_changes, pre_dispatch_failures = [], [], []
    previous_skills, inherited_read_cases = {}, []
    skill_transitions, anchor_restorations = 0, 0
    previous_experience, recall_cases = {}, []
    source = json.loads((run / "subject-source.json").read_text())
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    corrected = "corrective1" in plan["protocol"]
    foundation = plan["protocol"].startswith("past-foundation-")
    subject_path = root / ("scripts/past-foundation-turn.ts" if foundation else ".mentat/past-rsi-turn-corrected.ts" if corrected else "scripts/past-rsi-turn.ts")
    runner_path = root / ("benchmarks/past-bench/foundation_probe.py" if foundation else ".mentat/past-rsi-corrected.py" if corrected else "benchmarks/past-bench/rsi_probe.py")
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
    rows = [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]
    keys = [(r["family"], r["arm"], r["index"]) for r in rows]
    if len(roster) != len(plan["roster"]) or len(keys) != len(set(keys)) or set(keys) != set(roster):
        errors.append("incomplete, duplicate or unplanned result roster")
    for row in rows:
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
        if foundation:
            allowed |= {"procedures_skills_list", "procedures_skill_view", "procedures_skill_save"}
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
        if foundation and row["status"] == "completed":
            before_artifacts = json.loads((trial / "artifacts-before.json").read_text())
            after_artifacts = json.loads((trial / "artifacts-after.json").read_text())
            if row["arm"] == "reset" and before_artifacts.get("native_skills"):
                errors.append(f"reset arm retained procedures: {trial}")
            saved = {c.get("input",{}).get("name"): c["input"] for c in response["calls"] if c["name"] == "procedures_skill_save" and c["status"] == "completed"}
            for skill in after_artifacts.get("native_skills", []):
                draft = saved.get(skill["name"])
                if row["arm"] == "reset" and (not draft or any(skill[k] != draft.get(k) for k in ["description", "applicability", "content", "evidence"]) or skill["version"] != draft["expectedVersion"]+1):
                    errors.append(f"procedural artifact not supported by successful native write: {trial}: {skill['name']}")
            reads = sum(c["name"] == "procedures_skill_view" and c["status"] == "completed" for c in response["calls"])
            if reads != after_artifacts["internal_tools"]["skill_read_count"]:
                errors.append(f"skill reads were not actual successful calls: {trial}")

        if any(e.get("status", "active") == "active" for e in before):
            errors.append(f"unexpected activation requires review: {trial}")
        semantic_events, selections, turn_inputs = [], [], []
        for trace_path in (trial / "subject/trace").glob("*/events.jsonl"):
            for line in trace_path.read_text().splitlines():
                event = json.loads(line)
                if plan.get("nativeRecall") and event["type"] in {"experience.selection", "turn.start"} and event.get("turnId") == response["taskTurnId"]:
                    data = event["data"]
                    if "artifact" in data:
                        artifact_path = (trace_path.parent / data["artifact"]).resolve()
                        if not artifact_path.is_relative_to(trace_path.parent.resolve()) or sha(artifact_path) != data["sha256"]:
                            errors.append(f"invalid native recall artifact: {trial}")
                            continue
                        data = json.loads(artifact_path.read_text())
                    if event["type"] == "experience.selection":
                        selections.append((event, data))
                    else:
                        turn_inputs.append(data["input"])
                if event["type"] == "agent.event":
                    data = event["data"]
                    if "artifact" in data:
                        artifact_path = (trace_path.parent / data["artifact"]).resolve()
                        if not artifact_path.is_relative_to(trace_path.parent.resolve()) or sha(artifact_path) != data["sha256"]:
                            errors.append(f"invalid semantic artifact: {trial}")
                            continue
                        data = json.loads(artifact_path.read_text())
                    if event.get("turnId") == response["taskTurnId"]:
                        semantic_events.append({"seq": event["seq"], "data": data})
                if event["type"] == "adapter.protocol":
                    frame_count += 1
                if event["type"] == "capture.gap":
                    errors.append(f"capture gap: {trial}")
        if plan.get("nativeRecall"):
            experience_before = json.loads((trial / "subject/experience-before.json").read_text())
            experience_after = json.loads((trial / "subject/experience-after.json").read_text())
            state_key = (row["family"], row["arm"])
            expected_experience = []
            if row["arm"] != "reset" and episode["persistence_allowed"]:
                if episode["history_mode"] == "from_anchor":
                    anchor = run / "state" / row["family"].split("/")[-1] / row["arm"] / "anchors" / episode["history_load_anchor"] / "experience"
                    expected_experience = read_records(anchor)
                elif episode["history_mode"] == "continue":
                    expected_experience = previous_experience.get(state_key, [])
            if identity(experience_before) != identity(expected_experience):
                errors.append(f"native experience continuation/anchor mismatch: {trial}")
            if identity(experience_after[:len(experience_before)]) != identity(experience_before) or len(experience_after) != len(experience_before) + 1:
                errors.append(f"native experience not append-only single turn: {trial}")
            previous_experience[state_key] = experience_after
            if len(selections) != 1 or len(turn_inputs) != 1:
                errors.append(f"missing/duplicate actual native recall selection or turn input: {trial}")
            else:
                event, selection = selections[0]
                errors.extend(f"{problem}: {trial}" for problem in check_selection(experience_before, selection, config["scope"], plan["nativeRecall"]["maxChars"]))
                if any(record["ts"] > event["ts"] for record in experience_before):
                    errors.append(f"future native source: {trial}")
                if selection["text"]:
                    blocks = [json.loads(line) for line in turn_inputs[0].get("context", "").splitlines()]
                    if not any(block.get("text") == selection["text"] and block.get("memoryScope") == "task" for block in blocks):
                        errors.append(f"selected native recall absent from actual turn input: {trial}")
                recall_cases.append({"taskId": row["taskId"], "arm": row["arm"], "bucket": row["bucket"], "selectedIds": selection["selectedIds"], "chars": selection["chars"]})
        if plan.get("nativeSkillSnapshots"):
            snapshots = [trial / "subject/skills-before.json", trial / "subject/skills-after.json"]
            if not all(p.exists() for p in snapshots):
                errors.append(f"missing native skill snapshots: {trial}")
                continue
            skills_before, skills_after = [json.loads(p.read_text())["entries"] for p in snapshots]
            before_artifacts = json.loads((trial / "artifacts-before.json").read_text())
            if before_artifacts["native_skills"] != skills_before:
                errors.append(f"controller/subject skill input mismatch: {trial}")
            after_path = trial / "artifacts-after.json"
            if after_path.exists() and json.loads(after_path.read_text())["native_skills"] != skills_after:
                errors.append(f"controller/subject skill output mismatch: {trial}")
            state_key = (row["family"], row["arm"])
            expected_skills = []
            if row["arm"] != "reset" and episode["persistence_allowed"]:
                if episode["history_mode"] == "from_anchor":
                    anchor = run / "state" / row["family"].split("/")[-1] / row["arm"] / "anchors" / episode["history_load_anchor"] / "skills.json"
                    expected_skills = json.loads(anchor.read_text())["entries"] if anchor.exists() else []
                    anchor_restorations += 1
                elif episode["history_mode"] == "continue":
                    expected_skills = previous_skills.get(state_key, [])
            if skills_before != expected_skills:
                errors.append(f"procedural history/anchor restoration mismatch: {trial}")
            errors.extend(f"{problem}: {trial}" for problem in validate_transition(skills_before, skills_after, response["calls"], episode["family_id"]))
            skill_transitions += 1
            previous_skills[state_key] = skills_after
            reads = inherited_reads(skills_before, response["calls"], semantic_events)
            if row["bucket"] == "evaluation" and reads:
                inherited_read_cases.append({"taskId": row["taskId"], "arm": row["arm"], "reads": reads})
    return {"status": "passed" if not errors else "failed", "scoredTrials": row_count, "unscoredTrials": unscored,
            "changedAnalysisFiles": analysis_changes, "preDispatchFailures": pre_dispatch_failures,
            "skillTransitionsChecked": skill_transitions, "anchorSkillRestorationsChecked": anchor_restorations, "inheritedProcedureReadCases": inherited_read_cases,
            "nativeSessions": len(session_ids), "environmentDispatchReceipts": dispatch_count,
            "nativeRecallCases": recall_cases,
            "protocolFrames": frame_count, "issues": errors,
            "coverage": "Frozen file hashes, allowlisted controller fields and tools, native tool calls versus real upstream dispatch receipts, effective model, fresh engine sessions, accounting completeness, empty reset memory/procedures and real skill writes/reads; when declared, per-episode skill snapshots, continuation/anchor lineage and reads completed before business writes. Not OS isolation or training contamination proof."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.run)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["status"] == "passed" else 1)
