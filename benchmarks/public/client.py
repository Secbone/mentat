"""Text-only HTTP bridge client; all model calls retain server-side ACP evidence."""
import json
import urllib.error
import urllib.request

MODEL = "opencode-go/deepseek-v4.1-flash"


class ModelClient:
    def __init__(self, base="http://127.0.0.1:8941", timeout=240):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def post(self, path, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        request = urllib.request.Request(
            self.base + path, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"model bridge HTTP {error.code}: {error.read().decode()}") from error

    def health(self):
        with urllib.request.urlopen(self.base + "/health", timeout=10) as response:
            return json.load(response)

    def complete(self, prompt):
        return self.messages([{"role": "user", "content": prompt}])

    def messages(self, messages):
        response = self.post("/v1/chat/completions", {"model": MODEL, "messages": messages})
        return response["choices"][0]["message"]["content"], response

    def ingest(self, corpus_id, history):
        return self.post("/history", {"corpusId": corpus_id, "history": history})

    def subject(self, history, question, budget=12000, *, corpus_id=None, policy=None, before=None):
        payload = {
            "model": MODEL,
            "input": {"text": question, "memoryScope": "task", **({"hostPolicy": policy} if policy else {})},
            "historyBudgetChars": budget,
        }
        if corpus_id is None:
            payload["history"] = history
        else:
            if history is not None:
                raise ValueError("choose shared corpus or inline history")
            payload["corpusId"] = corpus_id
        if before is not None:
            payload["historyBefore"] = before
        return self.post("/subject", payload)
