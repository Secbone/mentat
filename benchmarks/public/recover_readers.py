"""Replay only requests whose original ACP guard failed before any prompt submission.

No successful answer is regenerated. Exact original request bodies and trace proofs
are retained; the original run remains immutable. Scoring uses the unchanged judge.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import tiktoken
from rank_bm25 import BM25Okapi
from audit_text_transport import payload
from client import ModelClient
from longmemeval import DATA, DATA_SHA, UPSTREAM, sanitize, verification
from upstream import load_function


def no_inference(request):
    proofs = []
    paths = list((request / "trace").rglob("events.jsonl"))
    assert paths and not (request / "response.json").exists(), "request already has a response"
    for path in paths:
        for seq, line in enumerate(path.read_text().splitlines()):
            event = json.loads(line)
            assert event["seq"] == seq
            data = payload(path.parent, event)
            assert event["type"] not in ["turn.start", "capture.gap"], "prior inference or incomplete proof"
            assert not (event["type"] == "agent.event" and data.get("type") == "run.started")
            if event["type"] == "adapter.protocol":
                assert not (data.get("direction") == "out" and data.get("data", {}).get("method") == "session/prompt")
        proofs.append({"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return {"requestPath": str((request / "request.json").resolve()),
            "requestSha256": hashlib.sha256((request / "request.json").read_bytes()).hexdigest(),
            "traces": proofs, "priorPromptSubmissions": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--transport", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    summary = json.loads((args.run / "summary.json").read_text())  # terminal only
    manifest = summary["manifest"]
    assert hashlib.sha256(DATA.read_bytes()).hexdigest() == DATA_SHA == manifest["datasetSha256"]
    refs = {r["question_id"]: r for r in json.loads(DATA.read_bytes())}
    client = ModelClient()
    health = client.health()
    for key in ["model", "codeSha256", "harness", "samplingControl", "messageDelivery"]:
        assert health[key] == manifest["transport"][key]
    judge, judge_hash = load_function(UPSTREAM / "src/evaluation/evaluate_qa.py", "get_anscheck_prompt")
    reader, reader_hash = load_function(UPSTREAM / "src/generation/run_generation.py", "prepare_prompt", {"json": json})
    retrieve, retrieve_hash = load_function(UPSTREAM / "src/retrieval/run_retrieval.py", "run_flat_retrieval", {"np": np, "BM25Okapi": BM25Okapi}, "DenseRetrievalMaster")
    builder, builder_hash = load_function(UPSTREAM / "src/retrieval/run_retrieval.py", "process_item_flat_index")
    assert (judge_hash, reader_hash, retrieve_hash, builder_hash) == tuple(manifest[k] for k in ["judgeFunctionSha256", "readerFunctionSha256", "retrievalFunctionSha256", "corpusFunctionSha256"])
    tokenizer = tiktoken.get_encoding("cl100k_base")
    rows = [json.loads(line) for line in (args.run / "results.jsonl").read_text().splitlines()]
    failed_requests = []
    for request in (args.transport / "requests").iterdir():
        if request.is_dir() and not (request / "response.json").exists():
            failed_requests.append((request, json.loads((request / "request.json").read_text())))
    args.out.mkdir()
    recovered, failures = [], []
    for row in rows:
        if row["status"] == "completed" or row.get("hypothesis") or "ACP model mismatch" not in row.get("error", ""):
            continue
        ref = refs[row["question_id"]]
        clean, history = sanitize(ref)
        if row["agent"] == "mentat-episodic":
            expected = {"model": manifest["readerModel"], "history": history,
                        "input": {"text": f"Current Date: {ref['question_date']}\nQuestion: {ref['question']}\nAnswer based on relevant historical observations.", "memoryScope": "task"},
                        "historyBudgetChars": manifest["nativeHistoryBudgetChars"]}
            kind, route = "subject", "/subject"
        else:
            corpus, ids = [], []
            for sid, date, session in zip(clean["haystack_session_ids"], clean["haystack_dates"], clean["haystack_sessions"]):
                texts, keys, _ = builder(session, "session", sid, date)
                corpus.extend(texts); ids.extend(keys)
            ranks = retrieve(None, clean["question"], "flat-bm25", corpus)
            clean["retrieval_results"] = {"ranked_items": [{"corpus_id": ids[int(i)], "text": corpus[int(i)]} for i in ranks]}
            prompt = reader(clean, "flat-session", 10, False, "json", False, tokenizer, "openai", 4000, "none")
            expected = {"model": manifest["readerModel"], "messages": [{"role": "user", "content": prompt}]}
            kind, route = "reader", "/v1/chat/completions"
        matches = [(p, r) for p, r in failed_requests if r["kind"] == kind and r["body"] == expected]
        assert len(matches) == 1, "original pre-inference request not uniquely identified"
        request, original_request = matches[0]
        assert original_request["transport"]["codeSha256"] == manifest["transport"]["codeSha256"]
        proof = no_inference(request)
        started = time.monotonic()
        try:
            response = client.post(route, expected)
            hypothesis = response["text"] if kind == "subject" else response["choices"][0]["message"]["content"]
            observation, reader_evidence = verification(response)
            text, scored = client.complete(judge(ref["question_type"], ref["question"], ref["answer"], hypothesis, abstention=ref["question_id"].endswith("_abs")))
            judge_observation, judge_evidence = verification(scored)
            costs = [observation["costUsd"], judge_observation["costUsd"]]
            replacement = {**row, "status": "completed", "correct": "yes" in text.lower(), "hypothesis": hypothesis,
                           "judgeResponse": text, "judgeFormatValid": text.strip().lower().rstrip(".") in ["yes", "no"],
                           "error": None, "evidence": [reader_evidence, judge_evidence],
                           "durationMs": (row["durationMs"] or 0) + int((time.monotonic() - started) * 1000),
                           "costUsd": sum(costs) if all(c is not None for c in costs) else None}
            recovered.append({"kind": "pre-inference-reader", "original": row, "replacement": replacement, "proof": proof,
                              "policy": "post-hoc identity-guard recovery; zero prior prompt submissions; exact original request replayed once"})
        except Exception as error:
            failures.append({"original": row, "proof": proof, "error": str(error)})
        (args.out / "recoveries.json").write_text(json.dumps({"sourceRun": str(args.run.resolve()), "judgeFunctionSha256": judge_hash,
                                                             "items": recovered, "failedAttempts": failures}, indent=2) + "\n")
        print(json.dumps({"recovered": len(recovered), "failed": len(failures)}), flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
