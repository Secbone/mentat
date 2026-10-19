"""Text-only OpenViking VLM adapter to the audited OpenCode model bridge.

No credentials, embeddings, streaming, or native tool execution are provided.
Structured content is serialized to text; non-text parts and tools fail closed.
Every original request and upstream response is retained in a new directory.
"""
import argparse
import json
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from client import ModelClient


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(
        isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str)
        for p in value
    ):
        return "\n".join(p["text"] for p in value)
    raise ValueError("only text content is supported")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8944")
    parser.add_argument("--port", type=int, default=8945)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    client = ModelClient(args.base, timeout=600)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.reply(200, client.health())

        def reply(self, status, value):
            raw = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            directory = args.out / str(uuid.uuid4())
            directory.mkdir()
            try:
                if self.path != "/v1/chat/completions":
                    raise ValueError("unsupported route")
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 32 * 1024**2:
                    raise ValueError("invalid request size")
                body = json.loads(self.rfile.read(size))
                (directory / "request.json").write_text(json.dumps(body, ensure_ascii=False, indent=2))
                if body.get("stream") or body.get("tools") or body.get("functions"):
                    raise ValueError("native tools/streaming are unavailable through OpenCode text bridge")
                messages = [{"role": m["role"], "content": text_content(m.get("content"))}
                            for m in body["messages"]]
                response = client.post("/v1/chat/completions", {"model": body["model"], "messages": messages})
                (directory / "response.json").write_text(json.dumps(response, ensure_ascii=False, indent=2))
                self.reply(200, response)
            except Exception as exc:
                error = {"error": {"message": str(exc), "type": "openviking_text_adapter_error"}}
                (directory / "error.json").write_text(json.dumps(error))
                self.reply(400, error)

        def log_message(self, fmt, *values):
            print(fmt % values, flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"port": args.port, "base": args.base, "out": str(args.out)}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
