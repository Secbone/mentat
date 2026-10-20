"""PAST task/anchor diagnostic with native Mentat memory and upstream graders.

This is an adapted protocol, not PAST's Hermes persistence implementation or a
claim of recursive self-improvement. Labels and fixtures remain controller-side.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".mentat/upstream/past-bench"
sys.path.insert(0, str(UPSTREAM / "src"))

import httpx
from past_bench.graders.registry import get_grader
from past_bench.models.content import TextBlock, ToolUseBlock
from past_bench.models.message import Message
from past_bench.models.self_evolve import SelfEvolveSequenceDefinition
from past_bench.models.task import TaskDefinition
from past_bench.models.trace import AuditSnapshot, TraceEnd, TraceMessage, TraceStart
from past_bench.runner.dispatcher import ToolDispatcher
from past_bench.runner.self_evolve import PersistenceBackend, _empty_artifact_summary, grade_episode
from past_bench.runner.services import ServiceManager
from past_bench.self_evolve_v2 import generate_manifest
from past_bench.trace.writer import TraceWriter

MODEL = "opencode-go/deepseek-v4.1-flash"
FAMILIES = [
    "memory_ability/SM01_preference_adoption",
    "memory_ability/SM02_constraint_retention",
    "procedural_ability/PC03_latent_rule_induction_01",
    "procedural_ability/PC04_failure_to_rule_01",
]
ARMS = ["reset", "memory", "reflect"]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def entries(state):
    path = state / "memory.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else data.get("entries", [])


def artifact(state, response=None):
    result = _empty_artifact_summary(state)
    rows = entries(state)
    active = [r for r in rows if r.get("status", "active") == "active"]
    result.update(memory_file_exists=bool(active), memory_entries=[r["text"] for r in active], memory_chars=sum(len(r["text"]) for r in active))
    # Native calls are reported as native calls; no invented skill/search events.
    calls = (response or {}).get("calls", [])
    counts = Counter(c["name"] for c in calls)
    result["internal_tools"].update(
        tool_call_counts=dict(counts),
        memory_calls=sum(v for k, v in counts.items() if k.startswith("direct_memory_memory_")),
        memory_read_count=counts["direct_memory_memory_search"],
        memory_write_count=counts["direct_memory_memory_add"],
    )
    # Project actual native procedural artifacts; never synthesize skill contents.
    skill_path = state / "skills.json"
    skills = json.loads(skill_path.read_text())["entries"] if skill_path.exists() else []
    for skill in skills:
        assert skill["origin"] == "agent-procedure" and skill["version"] >= 1
    docs = {s["name"]: {"path": str(skill_path) + "#" + s["name"],
            "content": "\n".join(s[k] for k in ["description", "applicability", "content", "evidence"]),
            "version": s["version"]} for s in skills}
    for doc in docs.values():
        doc["sha1"] = hashlib.sha1(doc["content"].encode()).hexdigest()
        doc["preview"] = doc["content"][:200]
    result.update(skill_count=len(skills), skill_names=sorted(docs), skill_docs=docs)
    successful = [c for c in calls if c.get("status") == "completed"]
    creates = sum(c["name"] == "procedures_skill_save" and c.get("input", {}).get("expectedVersion") == 0 for c in successful)
    updates = sum(c["name"] == "procedures_skill_save" and c.get("input", {}).get("expectedVersion", 0) > 0 for c in successful)
    result["internal_tools"].update(
        skills_list_calls=sum(c["name"] == "procedures_skills_list" for c in successful),
        skill_view_calls=sum(c["name"] == "procedures_skill_view" for c in successful),
        skill_read_count=sum(c["name"] == "procedures_skill_view" for c in successful),
        skill_manage_calls=creates+updates, skill_create_count=creates, skill_update_count=updates,
        skill_manage_action_counts={"create": creates, "edit": updates},
    )
    result["native_entries"] = rows
    result["native_skills"] = skills
    return result


class ToolServer(socketserver.UnixStreamServer):
    allow_reuse_address = False


def tool_server(path, token, task, writer, trace_id):
    endpoints = {e.tool_name: e for e in task.tool_endpoints}
    dispatcher = ToolDispatcher(endpoints)
    names = {t.name for t in task.tools}
    count = [0]

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != "/call" or self.headers.get("Authorization") != f"Bearer {token}":
                self.send_error(403)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1024 * 1024:
                    raise ValueError("request size")
                body = json.loads(self.rfile.read(size))
                if set(body) != {"name", "arguments"} or body["name"] not in names or not isinstance(body["arguments"], dict):
                    raise ValueError("tool outside task allowlist")
                count[0] += 1
                call = ToolUseBlock(id=f"dispatch-{count[0]}", name=body["name"], input=body["arguments"])
                writer.write_event(TraceMessage(trace_id=trace_id, message=Message(role="assistant", content=[call])))
                result, event = dispatcher.dispatch(call, trace_id)
                writer.write_event(event)
                writer.write_event(TraceMessage(trace_id=trace_id, message=Message(role="user", content=[result])))
                output = "\n".join(c.text for c in result.content)
                try:
                    output = json.loads(output)
                except ValueError:
                    pass
                encoded = json.dumps({"status": "error" if result.is_error else "ok", "output": output}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except Exception as error:
                self.send_error(400, str(error))

    server = ToolServer(str(path), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, dispatcher, thread, count


def run_episode(task, episode, arm, state, out, timeout, port_offset):
    out.mkdir(parents=True)
    task.apply_port_offset(port_offset)
    # Never reuse or reset a service that belongs to another experiment.
    for service in task.services:
        import socket
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", service.port)) == 0:
                raise RuntimeError(f"task service port already in use: {service.port}")
    tools = [{"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in task.tools]
    write(out / "tools.json", tools)
    before = artifact(state)
    write(out / "artifacts-before.json", before)
    trace_id = str(uuid.uuid4())
    trace = out / "upstream-trace.jsonl"
    response = None
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="mentat-past-") as socket_dir, TraceWriter(trace) as writer:
        writer.write_event(TraceStart(trace_id=trace_id, task_id=task.task_id, model=MODEL))
        writer.write_event(TraceMessage(trace_id=trace_id, message=Message(role="user", content=[TextBlock(text=task.prompt.text)])))
        token = uuid.uuid4().hex
        server, dispatcher, thread, count = tool_server(Path(socket_dir) / "task.sock", token, task, writer, trace_id)
        try:
            with ServiceManager(task.services, cwd=UPSTREAM):
                config = {"socketPath": str(Path(socket_dir) / "task.sock"), "token": token,
                          "toolsPath": str(out / "tools.json"), "query": task.prompt.text,
                          "stateDir": str(state), "scope": episode.family_id,
                          "reflect": arm == "reflect" and episode.bucket not in {"baseline", "evaluation", "control"},
                          "timeoutMs": timeout * 1000, "maxSteps": task.environment.max_turns}
                write(out / "controller.json", config)
                process = subprocess.run(["node", "--import", "tsx", "scripts/past-foundation-turn.ts", str(out / "controller.json"), str(out / "subject")],
                                         cwd=ROOT, capture_output=True, text=True, timeout=timeout * 2 + 60)
                (out / "stdout.log").write_text(process.stdout)
                (out / "stderr.log").write_text(process.stderr)
                response_path = out / "subject/response.json"
                if process.returncode or not response_path.exists():
                    raise RuntimeError(f"subject exit={process.returncode}: {process.stderr[-2000:]}")
                response = json.loads(response_path.read_text())
                models = response["observations"]["models"]
                if not models or any(m.get("effective") != MODEL for m in models):
                    raise RuntimeError("actual model identity mismatch")
                if response["reason"] not in {"done", "length"} and not str(response.get("error", "")).startswith(("invalid final answer:", "run ended with unfinished tool calls")):
                    raise RuntimeError(f"unfinished subject: {response['reason']}: {response.get('error')}")
                for service in task.services:
                    if not service.reset_endpoint:
                        continue
                    url = service.reset_endpoint.rsplit("/reset", 1)[0] + "/audit"
                    audit = httpx.get(url, timeout=10, trust_env=False)
                    audit.raise_for_status()
                    writer.write_event(AuditSnapshot(trace_id=trace_id, service_name=service.name, audit_url=url, audit_data=audit.json()))
                writer.write_event(TraceMessage(trace_id=trace_id, message=Message(role="assistant", content=[TextBlock(text=response["text"])])))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            dispatcher.close()
        accounting = response["observations"]["accounting"]
        sessions = accounting.get("sessions", [])
        input_tokens = sum(s.get("tokens_input", 0) for s in sessions)
        output_tokens = sum(s.get("tokens_output", 0) for s in sessions)
        writer.write_event(TraceEnd(trace_id=trace_id, total_turns=count[0] + 1,
                                    model_input_tokens=input_tokens, model_output_tokens=output_tokens,
                                    input_tokens=input_tokens, output_tokens=output_tokens,
                                    total_tokens=input_tokens + output_tokens, wall_time_s=time.monotonic() - started,
                                    model_time_s=time.monotonic() - started, other_time_s=0))
    after = artifact(state, response)
    write(out / "artifacts-after.json", after)
    result = grade_episode(trace_path=trace, task=task, tasks_dir=UPSTREAM / "self-evolve-tasks-v2",
                           task_dir=Path(task.task_file).parent,
                           grader=get_grader(task.task_id, tasks_dir=UPSTREAM / "self-evolve-tasks-v2", task_dir=Path(task.task_file).parent),
                           judge=None, env_snapshot={}, artifact_before=before, artifact_summary=after,
                           expected_persistence_signal=episode.expected_persistence_signal)
    result.update(status="completed", costUsd=response["observations"]["costUsd"],
                  validFinalAnswer=response["reason"] == "done", answerError=response.get("error"),
                  nativeMemory=response["observations"]["memory"], reflection=response["reflection"],
                  nativeCalls=response["calls"], nativeModels=response["observations"]["models"],
                  activeBefore=len(before["memory_entries"]), activeAfter=len(after["memory_entries"]),
                  candidateAfter=sum(r.get("status") == "candidate" for r in after["native_entries"]))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--families", nargs="+", choices=FAMILIES, default=FAMILIES)
    parser.add_argument("--arms", nargs="+", choices=ARMS, default=ARMS)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--limit", type=int, default=0, help="smoke only; never a full-family result")
    parser.add_argument("--buckets", nargs="+", choices=["evaluation"], help="fixed transfer subset; reset arm only")
    parser.add_argument("--reset-evaluation-only", action="store_true", help="paired RSI: reset eval8 plus all memory episodes")
    parser.add_argument("--port-offset", type=int, default=12000)
    args = parser.parse_args()
    args.out = args.out.resolve()
    if args.reset_evaluation_only and (set(args.arms) != {"reset", "memory"} or args.buckets or args.limit):
        parser.error("paired RSI requires reset+memory arms, no buckets/limit")
    def selected(episode, index, arm):
        return (not args.limit or index < args.limit) and (not args.buckets or episode.bucket in args.buckets) and (not args.reset_evaluation_only or arm != "reset" or episode.bucket == "evaluation")
    if args.buckets and args.arms != ["reset"]:
        parser.error("bucket selection requires reset: learning history cannot be omitted")
    assert len(set(args.families)) == len(args.families) and len(set(args.arms)) == len(args.arms)
    assert 30 <= args.timeout <= 300 and args.limit >= 0
    assert shutil.disk_usage(ROOT).free >= 30 * 1024 ** 3
    args.out.mkdir()
    sequences, tasks, roster, hashes = {}, {}, [], {}
    for family in args.families:
        path = args.out / "manifests" / f"{Path(family).name}.yaml"
        path.parent.mkdir(exist_ok=True)
        generate_manifest(family, out_path=path)
        sequence = SelfEvolveSequenceDefinition.from_yaml(path)
        sequences[family] = sequence
        for index, episode in enumerate(sequence.episodes):
            task_path = Path(episode.task)
            task = TaskDefinition.from_yaml(task_path / "task.yaml" if task_path.is_dir() else task_path)
            # Native Hermes seeds cannot be silently omitted or re-labelled user confirmations.
            if episode.initial_home_fixture_dir or episode.preseed_artifacts_dir or any(task.hermes_home_seed.model_dump().values() if task.hermes_home_seed else []):
                raise ValueError(f"unsupported foreign persistence fixture: {episode.task}")
            tasks[episode.task] = task
            for source in Path(task.task_file).parent.rglob("*"):
                if source.is_file() and "__pycache__" not in source.parts:
                    hashes[str(source.relative_to(UPSTREAM))] = digest(source)
            for arm in args.arms:
                if selected(episode, index, arm):
                    roster.append({"family": family, "arm": arm, "index": index, "taskId": task.task_id, "episode": episode.model_dump(mode="json")})
    sources = {str(p.relative_to(UPSTREAM)): digest(p) for p in (UPSTREAM / "src/past_bench").rglob("*.py")}
    hashes = {str(p.relative_to(UPSTREAM)): digest(p) for p in (UPSTREAM / "self-evolve-tasks-v2").rglob("*") if p.is_file() and "__pycache__" not in p.parts}
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    archive = []
    for name in sorted(set(filter(None, names))):
        source = ROOT / name
        if source.is_file():
            archive.append({"name": name, "sha256": digest(source), "base64": base64.b64encode(source.read_bytes()).decode()})
    write(args.out / "subject-source.json", archive)
    plan = {"protocol": "past-foundation-diagnostic-v5", "track": "adapted", "model": MODEL,
            "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "upstreamRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip(),
            "nativeSkillSnapshots": True, "pairedResetEvaluationOnly": args.reset_evaluation_only,
            "primaryAcceptance": {"bucket": "evaluation", "scoreArm": "memory", "baselineArm": "reset", "minimumScore100": 50, "gain": "strictly positive", "nativeReuseRequired": True} if args.reset_evaluation_only else None,
            "scope": "fixed-four-family-rsi-pair" if args.reset_evaluation_only else "smoke" if args.limit else "fixed-four-family-transfer" if args.buckets else "four-complete-families", "selectedBuckets": args.buckets, "roster": roster,
            "datasetHashes": hashes, "upstreamScorerSourceHashes": sources,
            "runnerSha256": digest(Path(__file__)), "subjectSha256": digest(ROOT / "scripts/past-foundation-turn.ts"),
            "subjectArchiveSha256": digest(args.out / "subject-source.json"),
            "timeoutSeconds": args.timeout, "portOffset": args.port_offset,
            "startupReadiness": "fresh memory, environment and procedures tools/list receipts plus 1000ms OpenCode v2.0.25 compatibility settling; no model warmup; task failures remain scored",
            "arms": {"reset": "fresh native memory and experience each episode", "memory": "native state persisted, no scheduled reflection", "reflect": "same state plus native reflection after learning episodes; candidates not auto-activated"},
            "limits": ["not an autonomous code or policy evolution loop", "no hidden-label feedback to subject or reflection", "no LLM communication judge", "native memory and procedural artifact projection separate from Hermes storage", "no OS-level network isolation", "one repetition", "reflection consumes extra budget; compare cost explicitly"],
            "unsupportedFamilies": ["PG01_release_decision_followup", "PG04_temporary_waiver_audit", "SM03_fact_correction", "SM06_temporary_exception_pollution"],
            "unsupportedReason": "foreign Hermes memory/skill/session fixtures require a validated native mapping"}
    write(args.out / "plan.json", plan)
    records = []
    backend = PersistenceBackend()
    for family in args.families:
        sequence = sequences[family]
        for arm in args.arms:
            state = args.out / "state" / Path(family).name / arm / "current"
            anchors = args.out / "state" / Path(family).name / arm / "anchors"
            known = {}
            backend.reset_state(state)
            for index, episode in enumerate(sequence.episodes):
                if args.limit and index >= args.limit:
                    break
                if not selected(episode, index, arm):
                    continue
                if arm == "reset" or not episode.persistence_allowed:
                    backend.reset_state(state)
                else:
                    backend.prepare_history(state_root=state, episode=episode, history_anchors=known)
                task = tasks[episode.task].model_copy(deep=True)
                out = args.out / "trials" / Path(family).name / arm / f"{index:02d}"
                record = {"family": family, "arm": arm, "index": index, "taskId": task.task_id, "bucket": episode.bucket, "stage": episode.stage, "transferDistance": episode.transfer_distance}
                print(f"START {family} {arm} {index + 1}/{len(sequence.episodes)} {episode.bucket}", flush=True)
                try:
                    result = run_episode(task, episode, arm, state, out, args.timeout, args.port_offset)
                    record.update(result)
                except Exception as error:
                    record.update(status="error", error=str(error), passed=None, task_score=None)
                # Save even an empty anchor; never drop a later trial from the roster.
                backend.save_anchor(state_root=state, episode=episode, anchors_dir=anchors, history_anchors=known)
                records.append(record)
                with (args.out / "results.jsonl").open("a") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                write(out / "result.json", record)
                print(f"END {arm} {task.task_id} {record['status']} score={record.get('task_score')} pass={record.get('passed')}", flush=True)
                write(args.out / "progress.json", {"completed": len(records), "planned": len(roster), "statuses": dict(Counter(r["status"] for r in records))})
                # Connection/auth/quota failures block all arms: stop without turning them into task failures.
                if record["status"] == "error" and "turn timed out" not in record.get("error", ""):
                    write(args.out / "interruption.json", {"reason": record["error"], "completed": len(records), "remaining": len(roster) - len(records)})
                    return 2
    assert len(records) == len(roster)
    write(args.out / "complete.json", {"records": len(records), "planned": len(roster), "status": "completed-with-budget-failures" if any(r["status"] != "completed" for r in records) else "completed"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
