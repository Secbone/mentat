"""PersonaMem-v2 full public text MCQ, native episodic vs upstream long context.

The upstream option builder, extractor and correctness function are loaded unchanged.
No profile, reference answer, preference label or relevant-snippet annotations enter
history ingestion. Only randomized visible answer choices enter the answer request.
"""
import argparse
import ast
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from client import MODEL, ModelClient
from resources import require_disk
from upstream import load_function

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / ".mentat/benchmark-data/personamem-v2"
UPSTREAM = ROOT / ".mentat/upstream/personamem-v2"
BENCHMARK = DATA / "benchmark/text/benchmark.csv"
AGENTS = ["mentat-episodic", "personamem-v2-long-context"]
SUFFIX = " Please recall my related preferences from our conversation history to give personalized responses."


def functions():
    result, hashes = {}, {}
    for name in ["create_mcq_options", "extract_final_answer", "check_mcq_correctness"]:
        result[name], hashes[name] = load_function(
            UPSTREAM / "inference.py", name,
            {"List": List, "Tuple": Tuple, "Dict": Dict}, "PersonaBenchmarkEvaluator")
    return result, hashes


def parse_query(value):
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = ast.literal_eval(value)
    if not isinstance(parsed, dict) or parsed.get("role") != "user" or not isinstance(parsed.get("content"), str):
        raise ValueError("invalid upstream query")
    return parsed["content"] + SUFFIX


def load_history(relative):
    path = (DATA / relative).resolve()
    if not path.is_relative_to(DATA.resolve()):
        raise ValueError("history path outside dataset")
    raw = path.read_bytes()
    data = json.loads(raw)
    # Other fields contain annotations and must never be ingested.
    history = data["chat_history"] if isinstance(data, dict) else data
    if not isinstance(history, list) or not history:
        raise ValueError("missing chat history")
    clean = []
    for message in history:
        if message.get("role") not in ["user", "assistant", "system"] or not isinstance(message.get("content"), str):
            raise ValueError("unsupported historical message")
        clean.append({"role": message["role"], "content": message["content"]})
    return clean, hashlib.sha256(raw).hexdigest()


def evidence(response):
    if "observations" in response:
        return response["observations"], str(Path(response["evidenceDir"]).parent.parent / "response.json")
    path = Path(response["mentat"]["evidenceDir"]).parent
    return json.loads((path / "verification.json").read_text()), str(path / "response.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base", default="http://127.0.0.1:8942")
    parser.add_argument("--sizes", nargs="+", choices=["32k", "128k"], default=["32k", "128k"])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    assert os.environ.get("PYTHONHASHSEED") == "0", "run with PYTHONHASHSEED=0 to reproduce upstream hash-based option seeds"
    assert 1 <= args.workers <= 8 and args.limit >= 0 and len(set(args.sizes)) == len(args.sizes)
    require_disk(args.out, incoming_bytes=25 * 1024 ** 3)
    raw = BENCHMARK.read_bytes()
    rows = list(csv.DictReader(io.StringIO(raw.decode())))
    assert len(rows) == 5000, "unexpected pinned public test row count"
    metadata = json.loads((ROOT / "benchmarks/public/dataset-metadata.json").read_text())
    receipt = json.loads(Path(str(BENCHMARK) + ".receipt.json").read_text())
    assert hashlib.sha256(raw).hexdigest() == receipt["sha256"]
    assert receipt["revision"] == metadata["datasets"]["personamem-v2"]["revision"]
    fn, scorer_hashes = functions()
    selected = rows[:args.limit] if args.limit else rows
    prepared = []
    # Upstream builder mutates global random state: prepare options serially.
    for index, row in enumerate(selected):
        query = parse_query(row["user_query"])
        wrong = json.loads(row["incorrect_answers"]) if row["incorrect_answers"] else []
        assert isinstance(wrong, list) and all(isinstance(a, str) for a in wrong)
        seed = hash(f"{row['persona_id']}_{query}") % 2**32
        policy, mapping = fn["create_mcq_options"](None, row["correct_answer"], wrong, seed=seed)
        for size in args.sizes:
            prepared.append({"id": f"text-{size}-{index:05d}", "row": row, "size": size,
                             "query": query, "policy": policy, "mapping": mapping, "seed": seed})
    args.out.mkdir()
    client = ModelClient(args.base)
    transport = client.health()
    assert transport["model"] == MODEL and transport.get("historyProtocol") == "shared-corpus-v2"
    manifest = {
        "schemaVersion": 1, "benchmark": "personamem-v2-text-mcq",
        "scope": "full-5000-per-size" if len(selected) == 5000 else "preflight-subset",
        "track": "adapted-model-transport", "sizes": args.sizes,
        "datasetSha256": hashlib.sha256(raw).hexdigest(), "datasetRevision": receipt["revision"],
        "upstreamRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip(),
        "scorerFunctionSha256": scorer_hashes, "optionHashSeed": "PYTHONHASHSEED=0",
        "optionSeedRule": "hash(persona_id + '_' + augmented_query) % 2**32, upstream unchanged",
        "agents": AGENTS, "transport": transport,
        "nativeHistoryBudgetChars": 12000, "baselineContext": "entire selected upstream history; no silent truncation",
        "learning": "ingest history once, independent question sessions; no reflection, answer feedback or label ingestion",
        "executionPolicy": {
            "id": "text-closed-book-v1", "assistantTools": "none",
            "externalSearch": "forbidden", "modelServiceNetwork": "required for inference only",
            "enforcement": "OpenCode tool deny + host permission deny; post-run ACP audit required",
            "osIsolation": "not-verified",
            "allowedInputs": ["selected user's chat_history role/content", "current question", "shuffled answer choices"],
            "forbiddenInputs": ["profile metadata", "reference-answer identity", "preference/relevant-snippet annotations", "other users' histories"],
            "policyDocumentSha256": hashlib.sha256((ROOT / "benchmarks/public/tool-policy.md").read_bytes()).hexdigest(),
        },
        "limitations": ["DeepSeek and serialized ACP messages replace published model/transport",
                         "Native retrieved context and baseline full context have different budgets; full-system comparison",
                         "Official option/extraction/correctness functions, no model judge needed for MCQ"],
        "planned": [{"id": p["id"], "size": p["size"], "personaId": p["row"]["persona_id"], "optionSeed": p["seed"]} for p in prepared],
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    histories = {}
    for item in prepared:
        relative = item["row"][f"chat_history_{item['size']}_link"]
        if relative not in histories:
            require_disk(args.out)
            clean, digest = load_history(relative)
            corpus_id = f"personamem-v2-{item['size']}-{digest}"
            history = [{"id": "conversation", "source": f"personamem-v2-text-{item['size']}",
                        "order": 0, "messages": clean}]
            ingested = client.ingest(corpus_id, history)
            histories[relative] = {"messages": clean, "corpusId": corpus_id, "sha256": digest, "receipt": ingested}
    (args.out / "history-manifest.json").write_text(json.dumps({
        key: {k: v for k, v in value.items() if k != "messages"} for key, value in histories.items()
    }, indent=2) + "\n")

    def evaluate(item):
        history = histories[item["row"][f"chat_history_{item['size']}_link"]]
        agents = AGENTS if int(hashlib.sha256(item["id"].encode()).hexdigest(), 16) % 2 else list(reversed(AGENTS))
        result = []
        for agent in agents:
            require_disk(args.out)
            started = time.monotonic()
            row = {"caseId": item["id"], "size": item["size"], "personaId": item["row"]["persona_id"],
                   "agent": agent, "status": "error", "correct": None, "costUsd": None, "evidence": []}
            try:
                if agent == "mentat-episodic":
                    response = client.subject(None, item["query"], corpus_id=history["corpusId"], policy=item["policy"])
                    text = response["text"]
                else:
                    text, response = client.messages(history["messages"] + [
                        {"role": "user", "content": item["query"]},
                        {"role": "system", "content": item["policy"]}])
                observation, path = evidence(response)
                predicted = fn["extract_final_answer"](None, text)
                correct = fn["check_mcq_correctness"](None, predicted, item["row"]["correct_answer"], item["mapping"])
                row.update(status="completed", correct=correct, hypothesis=text, predicted=predicted,
                           formatValid=bool(predicted), costUsd=observation["costUsd"], evidence=[path])
            except Exception as error:
                row["error"] = str(error)
            row["durationMs"] = int((time.monotonic() - started) * 1000)
            result.append(row)
        return result

    completed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool, (args.out / "results.jsonl").open("x") as stream:
        futures = {pool.submit(evaluate, item): item for item in prepared}
        for future in concurrent.futures.as_completed(futures):
            # Disk/resourcing errors stop scheduling/results; manifest keeps coverage incomplete.
            for row in future.result():
                completed.append(row)
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            stream.flush()
            print(json.dumps({"completed": len(completed), "planned": 2 * len(prepared)}), flush=True)
    summaries = {}
    for agent in AGENTS:
        for size in args.sizes:
            group = [r for r in completed if r["agent"] == agent and r["size"] == size]
            known = [r for r in group if r["correct"] is not None]
            users = defaultdict(list)
            for r in known:
                users[r["personaId"]].append(r["correct"])
            summaries[f"{agent}/{size}"] = {
                "planned": len(selected), "status": dict(Counter(r["status"] for r in group)),
                "measured": len(known), "unknown": len(group) - len(known),
                "accuracyObserved": sum(r["correct"] for r in known) / len(known) if known else None,
                "userMacroObserved": sum(sum(v)/len(v) for v in users.values()) / len(users) if users else None,
                "costUsdKnown": sum(r["costUsd"] or 0 for r in group),
                "unknownCostTasks": sum(r["costUsd"] is None for r in group),
            }
    (args.out / "summary.json").write_text(json.dumps({"manifest": manifest, "agents": summaries}, indent=2) + "\n")
    if any(v["unknown"] for v in summaries.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
