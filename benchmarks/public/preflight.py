"""Real model checks before full inference; no benchmark score is produced."""
import json
from pathlib import Path
from client import ModelClient
from upstream import load_function

root = Path(__file__).resolve().parents[2]
out = root / ".mentat/public-evaluations/preflight-v1"
out.mkdir()
client = ModelClient()
prompt, scorer_hash = load_function(
    root / ".mentat/upstream/longmemeval/src/evaluation/evaluate_qa.py", "get_anscheck_prompt"
)
results = []
for hypothesis, expected in [("Luna", "yes"), ("Nori", "no")]:
    text, raw = client.complete(prompt("single-session-user", "What is my cat's name?", "Luna", hypothesis))
    results.append({"type": "judge-calibration", "expected": expected, "answer": text, "raw": raw})
    assert text.strip().lower().rstrip(".") == expected, f"judge calibration failed: {text}"
subject = client.subject(
    [{"id": "fixture-history", "source": "preflight", "timestamp": 1735689600000,
      "messages": [{"role": "user", "content": "My cat's name is Luna."}]}],
    "What is my cat's name? Answer briefly.",
)
results.append({"type": "historical-subject", "raw": subject})
assert "Luna" in subject["text"], "historical retrieval failed"
(out / "results.json").write_text(json.dumps({"officialScorerFunctionSha256":scorer_hash,"results":results}, ensure_ascii=False, indent=2)+"\n")
print(json.dumps({"passed":True,"checks":len(results),"model":subject["transport"]["model"]}))
