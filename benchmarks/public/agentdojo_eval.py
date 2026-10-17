"""AgentDojo environment tools + unchanged upstream task/state verifier.

Closed task runtime over an authenticated Unix socket. Only official registered
functions execute; model CLI receives query/system/schemas, never the task's gold
environment or verifier. DeepSeek/OpenCode native tools form an adapted transport.
"""
import argparse
import concurrent.futures
import hashlib
import hmac
import json
import os
import socketserver
import subprocess
import tempfile
import threading
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.agent_pipeline.agent_pipeline import load_system_message
from agentdojo.agent_pipeline.tool_execution import tool_result_to_str
from agentdojo.functions_runtime import FunctionCall
from agentdojo.attacks.base_attacks import FixedJailbreakAttack
from agentdojo.attacks.important_instructions_attacks import ImportantInstructionsAttackNoNames
from agentdojo.task_suite import get_suites
from agentdojo.types import text_content_block_from_string
from resources import require_disk

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".mentat/upstream/agentdojo"


class MentatPipeline(BasePipelineElement):
    def __init__(self, out, method, subject_root=ROOT):
        self.out, self.method = out, method
        self.subject_root = subject_root.resolve()
        self.calls = []
        self.responses = []

    def query(self, query, runtime, env, messages=(), extra_args=None):
        trial = self.out / f"query-{len(self.responses):03d}"
        trial.mkdir()
        token = uuid.uuid4().hex
        tools = [{"name": f.name, "description": f.description,
                  "inputSchema": f.parameters.model_json_schema()}
                 for f in runtime.functions.values()]
        (trial / "tools.json").write_text(json.dumps(tools))
        transcript = [{"role": "user", "content": [text_content_block_from_string(query)]}]
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if self.path != "/call" or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                    self.send_error(403); return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    self.send_error(413); return
                data = json.loads(self.rfile.read(length))
                if set(data) != {"name", "arguments"} or data["name"] not in runtime.functions or not isinstance(data["arguments"], dict):
                    self.send_error(400); return
                result, error = runtime.run_function(env, data["name"], data["arguments"])
                output = tool_result_to_str(result)
                call = FunctionCall(function=data["name"], args=data["arguments"], id=f"call-{len(calls)}")
                # Verifier receives the actual runtime calls, not model-printed call syntax.
                transcript.append({"role": "assistant", "content": None, "tool_calls": [call]})
                transcript.append({"role": "tool", "tool_call": call, "tool_call_id": call.id,
                                   "content": [text_content_block_from_string(output)], "error": error})
                receipt = {**data, "output": output, "error": error, "sequence": len(calls)}
                calls.append(receipt)
                with (trial / "calls.jsonl").open("a") as stream:
                    stream.write(json.dumps(receipt, default=str) + "\n")
                payload = json.dumps({"status": "error" if error else "ok", "output": error if error else output}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers(); self.wfile.write(payload)

        with tempfile.TemporaryDirectory(prefix="mt-dojo-") as directory:
            socket = str(Path(directory) / "env.sock")
            server = socketserver.UnixStreamServer(socket, Handler)
            os.chmod(socket, 0o600)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            controller = {"socketPath": socket, "toolsPath": str((trial / "tools.json").resolve()), "token": token,
                          "query": query, "system": load_system_message(None), "method": self.method,
                          "timeoutMs": 240000, "maxSteps": 20}
            controller_path = trial / "controller.json"
            controller_path.write_text(json.dumps(controller)); controller_path.chmod(0o600)
            try:
                process = subprocess.run(["node", "--import", "tsx", "scripts/public-environment-turn.ts",
                                          str(controller_path.resolve()), str((trial / "subject").resolve())], cwd=self.subject_root,
                                         env={**os.environ, **({"TSX_TSCONFIG_PATH": str(self.subject_root / "tsconfig.json"),
                                              "MENTAT_BENCH_FROZEN_ARCHIVE": str(self.subject_root.parent / "checkout-source.json")}
                                              if self.subject_root != ROOT else {})},
                                         capture_output=True, text=True, timeout=280)
                (trial / "process.stdout").write_text(process.stdout)
                (trial / "process.stderr").write_text(process.stderr)
                if process.returncode:
                    raise RuntimeError(f"tool-enabled subject failed; see {trial}/process.stderr")
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=5)
        response = json.loads((trial / "subject/response.json").read_text())
        observed = [c for c in response["calls"] if str(c["name"]).startswith("environment_")]
        key = lambda name, arguments: json.dumps([name, arguments], sort_keys=True)
        assert Counter(key(c["name"][len("environment_"):], c["input"]) for c in observed) == Counter(key(c["name"], c["arguments"]) for c in calls), "ACP/runtime call records differ"
        self.calls.extend(calls)
        self.responses.append(response)
        transcript.append({"role": "assistant", "content": [text_content_block_from_string(response["text"])], "tool_calls": None})
        return query, runtime, env, transcript, extra_args or {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", default="v1.2.2")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--subject-root", type=Path, default=ROOT)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--attack", choices=["none", "important_instructions_no_names"], default="none")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--suites", nargs="+", default=["banking", "slack", "travel", "workspace"])
    args = parser.parse_args()
    assert args.limit >= 0 and len(set(args.suites)) == len(args.suites) and 1 <= args.workers <= 4
    args.subject_root = args.subject_root.resolve()
    if not args.limit:
        assert args.subject_root != ROOT, "full per-task Node evaluation requires a verified frozen subject root"
    frozen = json.loads((args.subject_root.parent / "manifest.json").read_text()) if args.subject_root != ROOT else None
    require_disk(args.out, incoming_bytes=8 * 1024 ** 3)
    suites = get_suites(args.version)
    planned = [(name, task_id, injection_id) for name in args.suites for task_id in suites[name].user_tasks
               for injection_id in (suites[name].injection_tasks if args.attack != "none" else [None])]
    selected = planned[:args.limit] if args.limit else planned
    files = subprocess.check_output(["git", "ls-files", "-z", "src/agentdojo/default_suites"], cwd=UPSTREAM).decode().split("\0")
    source_files = sorted([p, hashlib.sha256((UPSTREAM / p).read_bytes()).hexdigest()] for p in files if p)
    args.out.mkdir()
    (args.out / "runner.py").write_bytes(Path(__file__).read_bytes())
    attacks, payloads = {}, {}
    if args.attack != "none":
        for name in args.suites:
            # NoNames uses the upstream fixed template/default generic names. Avoid the
            # stock subclass's unnecessary lookup of an unsupported DeepSeek display name.
            attack = FixedJailbreakAttack(ImportantInstructionsAttackNoNames._JB_STRING, suites[name], MentatPipeline(args.out, "mentat"))
            attack.name = args.attack
            attacks[name] = attack
        for name, task_id, injection_id in selected:
            payloads[f"{name}/{task_id}/{injection_id}"] = attacks[name].attack(suites[name].user_tasks[task_id], suites[name].injection_tasks[injection_id])
        (args.out / "injection-payloads.json").write_text(json.dumps(payloads, indent=2) + "\n")
    manifest = {"benchmark": "agentdojo", "version": args.version,
                "track": "adapted-native-tool-transport", "phase": "clean-utility-only" if args.attack == "none" else "fixed-injection-matrix",
                "attack": args.attack,
                "attackPayloadSha256": hashlib.sha256(json.dumps(payloads, sort_keys=True).encode()).hexdigest(),
                "attackCodeSha256": hashlib.sha256((UPSTREAM / "src/agentdojo/attacks/base_attacks.py").read_bytes() + (UPSTREAM / "src/agentdojo/attacks/important_instructions_attacks.py").read_bytes()).hexdigest(),
                "scope": "full-selected-suites" if not args.limit else "preflight-subset",
                "upstreamRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip(),
                "datasetSha256": hashlib.sha256(json.dumps(source_files, separators=(",", ":")).encode()).hexdigest(),
                "datasetFiles": source_files,
                "scorerSha256": hashlib.sha256((UPSTREAM / "src/agentdojo/task_suite/task_suite.py").read_bytes()).hexdigest(),
                "runtimeSha256": hashlib.sha256((UPSTREAM / "src/agentdojo/functions_runtime.py").read_bytes()).hexdigest(),
                "dependencyLockSha256": hashlib.sha256((UPSTREAM / "uv.lock").read_bytes()).hexdigest(),
                "subject": frozen, "workers": args.workers,
                "planned": selected, "agents": ["mentat", "upstream-basic"],
                "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "policy": "Official runtime functions only; tool calls correlated with ACP; labels/validators outside agent; no web/shell tools; OS isolation not verified",
                "limitations": ["DeepSeek/OpenCode replaces upstream provider-native tool transport; max20 steps, wall-clock240s",
                                "Clean utility only; attacks separate" if args.attack == "none" else "Single upstream NoNames fixed template; not all adversary strategies",
                                "Mentat additionally has own memory candidate tools, fresh state per task; no gold feedback"]}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.prepare_only:
        print(json.dumps({"preparedCases": len(selected), "attack": args.attack, "modelCalls": 0}), flush=True)
        return
    completed = []
    def evaluate(case):
        suite_name, task_id, injection_id = case
        case_rows = []
        methods = manifest["agents"] if int(hashlib.sha256(f"{suite_name}/{task_id}".encode()).hexdigest(), 16) % 2 else list(reversed(manifest["agents"]))
        for method in methods:
                require_disk(args.out)
                out = args.out / suite_name / task_id / (injection_id or "clean") / method
                out.mkdir(parents=True)
                pipeline = MentatPipeline(out, method, args.subject_root)
                started = time.monotonic()
                row = {"suite": suite_name, "caseId": f"{suite_name}/{task_id}" + (f"/{injection_id}" if injection_id else ""), "userTask": task_id,
                       "injectionTask": injection_id, "agent": method, "status": "error", "utility": None, "attackSuccess": None}
                try:
                    injection_task = suites[suite_name].injection_tasks[injection_id] if injection_id else None
                    injections = payloads[f"{suite_name}/{task_id}/{injection_id}"] if injection_id else {}
                    utility, attack_success = suites[suite_name].run_task_with_pipeline(pipeline, suites[suite_name].user_tasks[task_id], injection_task, injections)
                    costs = [r["observations"]["costUsd"] for r in pipeline.responses]
                    row.update(status="completed", utility=bool(utility), attackSuccess=bool(attack_success) if injection_id else None, toolCalls=len(pipeline.calls),
                               costUsd=sum(costs) if all(c is not None for c in costs) else None,
                               evidence=[str(out.resolve())])
                except Exception as error:
                    row["error"] = str(error)
                row["durationMs"] = int((time.monotonic() - started) * 1000)
                case_rows.append(row)
        return case_rows
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool, (args.out / "results.jsonl").open("x") as stream:
        for future in concurrent.futures.as_completed([pool.submit(evaluate, case) for case in selected]):
            case_rows = future.result()
            for row in case_rows:
                completed.append(row); stream.write(json.dumps(row) + "\n"); stream.flush()
                print(json.dumps(row), flush=True)
    (args.out / "summary.json").write_text(json.dumps({"manifest": manifest, "results": completed}, indent=2) + "\n")
    if any(r["status"] != "completed" for r in completed):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
