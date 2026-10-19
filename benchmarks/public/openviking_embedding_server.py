"""Local English GGUF embedding endpoint for the OpenViking integration probe.

Only /v1/embeddings is implemented. No text-generation model or external service
is called. Exact inputs are token-bounded, vectors normalized, and request hashes
and timings retained. Run in the isolated OpenViking environment.
"""
import argparse
import hashlib
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llama_cpp import Llama, LLAMA_POOLING_TYPE_CLS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8947)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    model = Llama(model_path=str(args.model.resolve()), embedding=True, pooling_type=LLAMA_POOLING_TYPE_CLS,
                  n_ctx=512, n_batch=512, n_gpu_layers=-1, n_threads=4, verbose=False)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, value):
            raw = json.dumps(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self.reply(200, {"model":"bge-small-en-v1.5-f16","dimension":384,"contextTokens":512})

        def do_POST(self):
            started = time.monotonic()
            try:
                if self.path != "/v1/embeddings":
                    raise ValueError("unsupported route")
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 4*1024**2:
                    raise ValueError("invalid body size")
                body = json.loads(self.rfile.read(size))
                texts = body["input"]
                if isinstance(texts,str):
                    texts = [texts]
                if not texts or not all(isinstance(t,str) for t in texts):
                    raise ValueError("expected text inputs")
                if body.get("encoding_format","float") != "float":
                    raise ValueError("only float encoding supported")
                counts, clipped = [], []
                with lock:
                    for text in texts:
                        tokens = model.tokenize(text.encode(),add_bos=True)
                        counts.append(len(tokens))
                        clipped.append(model.detokenize(tokens[:510]).decode(errors="ignore"))
                    vectors = model.embed(clipped,normalize=True)
                if len(vectors) != len(texts) or any(len(v)!=384 or not all(math.isfinite(n) for n in v) for v in vectors):
                    raise ValueError("invalid embedding output")
                record = {"inputSha256":[hashlib.sha256(t.encode()).hexdigest() for t in texts],
                    "inputTokens":counts,"truncated":sum(n>510 for n in counts),
                    "durationMs":int((time.monotonic()-started)*1000)}
                with lock, (args.out/"requests.jsonl").open("a") as output:
                    output.write(json.dumps(record)+"\n")
                self.reply(200,{"object":"list","model":"bge-small-en-v1.5-f16",
                    "data":[{"object":"embedding","index":i,"embedding":v} for i,v in enumerate(vectors)],
                    "usage":{"prompt_tokens":sum(min(n,510) for n in counts),"total_tokens":sum(min(n,510) for n in counts)}})
            except Exception as exc:
                self.reply(400,{"error":{"message":str(exc)}})

        def log_message(self, fmt, *values):
            pass

    print(json.dumps({"ready":True,"port":args.port,"model":"bge-small-en-v1.5-f16"}),flush=True)
    ThreadingHTTPServer(("127.0.0.1",args.port),Handler).serve_forever()


if __name__ == "__main__":
    main()
