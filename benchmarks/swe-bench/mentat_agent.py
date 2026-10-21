"""Harbor adapter: Mentat host on the controller, coding tools only inside the task sandbox.

Never reads the task's solution, verifier, result.json or evaluation feedback.
The controller filesystem is not exposed as a model tool.
"""
from __future__ import annotations

import asyncio
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shlex
import socketserver
import tempfile
import time

from harbor.agents.base import BaseAgent

ROOT = Path(__file__).resolve().parents[2]
TOOLS = [{
    "name": "terminal",
    "description": "Run a shell command inside the isolated task repository. Use it to inspect, edit code and run existing tests. No internet access. Output is bounded.",
    "inputSchema": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
        "additionalProperties": False,
    },
}]


class MentatAgent(BaseAgent):
    def __init__(self, *args, timeout_ms=600000, max_steps=50, **kwargs):
        super().__init__(*args, **kwargs)
        self.timeout_ms = int(timeout_ms)
        self.max_steps = int(max_steps)
        if not 1000 <= self.timeout_ms <= 3000000 or not 1 <= self.max_steps <= 200:
            raise ValueError("invalid subject budget")

    @staticmethod
    def name():
        return "mentat"

    def version(self):
        return "coding-bridge-v2"

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        loop = asyncio.get_running_loop()
        # An explicit network probe is retained; failure closes the subject boundary.
        # A transparent proxy can accept a TCP handshake and reject the payload
        # later. Test end-to-end TLS/HTTP, not connect_ex() alone.
        probe_code = """import json, ssl, urllib.request
results = []
for url in ('https://example.com', 'https://1.1.1.1'):
    try:
        with urllib.request.urlopen(url, timeout=4, context=ssl._create_unverified_context()) as response:
            response.read(32)
            results.append({'url': url, 'reachable': True})
    except urllib.error.HTTPError as error:
        results.append({'url': url, 'reachable': True, 'status': error.code})
    except Exception as error:
        results.append({'url': url, 'reachable': False, 'error': str(error)})
print(json.dumps(results))
raise SystemExit(1 if any(row['reachable'] for row in results) else 0)
"""
        probe = await environment.exec(command="python3 -c " + shlex.quote(probe_code), timeout_sec=15)
        (self.logs_dir / "network-probe.json").write_text(json.dumps({"return_code": probe.return_code, "stdout": probe.stdout, "stderr": probe.stderr}))
        if probe.return_code != 0:
            raise RuntimeError("task sandbox network isolation not established")
        task_root = await environment.exec(command="if [ -d /app/.git ]; then printf /app; elif [ -d /testbed/.git ]; then printf /testbed; else exit 1; fi", timeout_sec=10)
        if task_root.return_code != 0 or task_root.stdout not in ("/app", "/testbed"):
            raise RuntimeError("unknown coding repository root")
        repo = task_root.stdout
        token = secrets.token_hex(32)
        calls = 0
        audit = self.logs_dir / "tool-calls.jsonl"

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(handler):
                nonlocal calls
                if handler.path != "/call" or handler.headers.get("Authorization") != f"Bearer {token}":
                    handler.send_error(403)
                    return
                try:
                    size = int(handler.headers.get("Content-Length", "0"))
                    if not 0 < size <= 65536:
                        raise ValueError("invalid request size")
                    value = json.loads(handler.rfile.read(size))
                    args = value.get("arguments", {})
                    if value.get("name") != "terminal" or set(args) != {"command"} or not isinstance(args["command"], str):
                        raise ValueError("invalid sandbox tool call")
                    calls += 1
                    if calls > self.max_steps:
                        raise ValueError("sandbox tool budget exhausted")
                    started = time.monotonic()
                    future = asyncio.run_coroutine_threadsafe(environment.exec(command=f"cd {repo} && " + args["command"], timeout_sec=120), loop)
                    result = future.result(timeout=135)
                    output = {"return_code": result.return_code, "stdout": (result.stdout or "")[-24000:], "stderr": (result.stderr or "")[-8000:]}
                    with audit.open("a") as f:
                        f.write(json.dumps({"call": calls, "command": args["command"], "output": output, "duration_ms": round((time.monotonic()-started)*1000)}) + "\n")
                    response = {"status": "ok" if result.return_code == 0 else "error", "output": output}
                except Exception as error:
                    response = {"status": "error", "output": str(error)}
                data = json.dumps(response).encode()
                handler.send_response(200)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Content-Length", str(len(data)))
                handler.end_headers()
                handler.wfile.write(data)

        import threading
        with tempfile.TemporaryDirectory(prefix="mc-", dir="/tmp") as directory:
            temp = Path(directory)
            tools = temp / "tools.json"
            tools.write_text(json.dumps(TOOLS))
            socket = temp / "s"
            server = Server(str(socket), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            configuration = temp / "subject.json"
            configuration.write_text(json.dumps({"instruction": instruction, "model": self.model_name, "socketPath": str(socket), "toolsPath": str(tools), "token": token, "timeoutMs": self.timeout_ms, "maxSteps": self.max_steps, "sourceArchivePath": str(self.logs_dir.parent.parent / "subject-source.json")}))
            process = None
            try:
                with (self.logs_dir / "subject.stdout.log").open("w") as stdout, (self.logs_dir / "subject.stderr.log").open("w") as stderr:
                    process = await asyncio.create_subprocess_exec("node", "--import", "tsx", str(ROOT / "scripts/coding-benchmark-turn.ts"), str(configuration), str(self.logs_dir / "host"), cwd=ROOT, stdout=stdout, stderr=stderr, start_new_session=True)
                    try:
                        await asyncio.wait_for(process.wait(), self.timeout_ms / 1000 + 90)
                    except (TimeoutError, asyncio.CancelledError):
                        import signal
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            await asyncio.wait_for(process.wait(), 10)
                        except TimeoutError:
                            os.killpg(process.pid, signal.SIGKILL)
                            await process.wait()
                        raise
                if process.returncode != 0:
                    raise RuntimeError(f"Mentat subject exited {process.returncode}; see subject.stderr.log")
            finally:
                # Capture partial changes even if a model timeout prevented a final answer.
                try:
                    patch = await environment.exec(command=f"cd {repo} && git add -N . && git diff --binary HEAD", timeout_sec=30)
                    if patch.return_code != 0:
                        raise RuntimeError("failed to capture coding patch")
                    (self.logs_dir / "model.patch").write_text(patch.stdout or "")
                    (self.logs_dir / "bridge.json").write_text(json.dumps({"protocol": self.version(), "memory": "reset-disabled", "model": self.model_name, "maxSteps": self.max_steps, "timeoutMs": self.timeout_ms, "toolCalls": calls, "patchSha256": hashlib.sha256((patch.stdout or "").encode()).hexdigest()}))
                finally:
                    await asyncio.to_thread(server.shutdown)
                    server.server_close()
                    thread.join(timeout=5)
