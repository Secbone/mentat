"""Real-model MCP/runtime smoke test. Synthetic fixture, never a public score."""
import argparse
import hmac
import json
import os
import socketserver
import subprocess
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from resources import require_disk

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
require_disk(args.out)
args.out.mkdir()
root = Path(__file__).resolve().parents[2]
results = []
for method in ["mentat", "upstream-basic"]:
    trial = args.out / method
    trial.mkdir()
    token, code = uuid.uuid4().hex, "answer-" + uuid.uuid4().hex
    calls = []
    catalog = [{"name": "lookup", "description": "Read the diagnostic code for a key.",
                "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"], "additionalProperties": False}}]
    tools = trial / "tools.json"; tools.write_text(json.dumps(catalog))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            if self.path != "/call" or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(403); return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if body != {"name": "lookup", "arguments": {"key": "diagnostic"}}:
                self.send_error(400); return
            calls.append(body)
            payload = json.dumps({"status": "ok", "output": {"code": code}}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(payload)))
            self.end_headers(); self.wfile.write(payload)

    with tempfile.TemporaryDirectory(prefix="mt-env-") as directory:
        socket = str(Path(directory) / "env.sock")
        server = socketserver.UnixStreamServer(socket, Handler)
        os.chmod(socket, 0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        controller = trial / "controller.json"
        controller.write_text(json.dumps({"socketPath": socket, "toolsPath": str(tools.resolve()), "token": token,
          "query": "Use lookup with key diagnostic. Tell me the diagnostic code returned by that tool.",
          "system": "Use only the declared task tools; never simulate a tool execution or invent a code.",
          "method": method, "maxSteps": 5, "timeoutMs": 120000})); controller.chmod(0o600)
        try:
            process = subprocess.run(["node", "--import", "tsx", "scripts/public-environment-turn.ts", str(controller.resolve()), str((trial / "subject").resolve())], cwd=root, capture_output=True, text=True, timeout=150)
            (trial / "process.stdout").write_text(process.stdout); (trial / "process.stderr").write_text(process.stderr)
            assert process.returncode == 0, f"subject error; see {trial}/process.stderr"
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
    response = json.loads((trial / "subject/response.json").read_text())
    passed = bool(calls) and code in response["text"] and any(c["name"] == "environment_lookup" for c in response["calls"])
    results.append({"method": method, "passed": passed, "runtimeCalls": len(calls), "toolNames": [c["name"] for c in response["calls"]], "evidence": str((trial / "subject/response.json").resolve())})
(args.out / "summary.json").write_text(json.dumps({"scope": __doc__, "results": results}, indent=2) + "\n")
print(json.dumps(results))
if not all(r["passed"] for r in results): raise SystemExit(1)
