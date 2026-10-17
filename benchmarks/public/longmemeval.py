"""Full cleaned-S evaluation, native Mentat history and unchanged upstream BM25.

Uses the pinned upstream reader/scoring functions. The judge and transport are
DeepSeek/OpenCode variants, so published scores using other judges are contextual.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import re
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import tiktoken
from rank_bm25 import BM25Okapi
from client import MODEL, ModelClient
from resources import require_disk
from upstream import load_function

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".mentat/upstream/longmemeval"
DATA = ROOT / ".mentat/benchmark-data/longmemeval-cleaned/s-cleaned.json"
DATA_SHA = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"


def sanitize(entry):
    """Allowlist only. Original IDs can reveal answer sessions, so make them opaque."""
    sessions, dates, ids, history = [], [], [], []
    for index, (date, messages) in enumerate(zip(entry["haystack_dates"], entry["haystack_sessions"])):
        sid = f"session-{index:04d}"
        clean = [{"role": m["role"], "content": m["content"]} for m in messages]
        if any(m["role"] not in ["user", "assistant"] for m in clean):
            raise ValueError("unsupported upstream history role")
        timestamp = datetime.datetime.strptime(re.sub(r" \([A-Za-z]+\)", "", date), "%Y/%m/%d %H:%M").replace(tzinfo=datetime.timezone.utc).timestamp()*1000
        sessions.append(clean)
        dates.append(date)
        ids.append(sid)
        history.append({"source":"longmemeval-cleaned-s","id":sid,"timestamp":timestamp,"messages":clean})
    assert len(sessions)==len(entry["haystack_sessions"])==len(entry["haystack_dates"])
    return {"question":entry["question"],"question_date":entry["question_date"],"haystack_sessions":sessions,"haystack_dates":dates,"haystack_session_ids":ids}, history


def verification(response):
    if "observations" in response:
        return response["observations"], str(Path(response["evidenceDir"]).parent.parent / "response.json")
    path = Path(response["mentat"]["evidenceDir"]).parent
    return json.loads((path/"verification.json").read_text()), str(path/"response.json")


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit",type=int,default=0,help="0 means full 500; partial runs explicitly labelled")
    parser.add_argument("--workers",type=int,default=4)
    parser.add_argument("--base",default="http://127.0.0.1:8941")
    parser.add_argument("--selection",type=Path,help="Frozen prior-error diagnostic cohort; not a representative sample")
    parser.add_argument("--agents",nargs="+",choices=["mentat-episodic","longmemeval-flat-bm25"],default=["mentat-episodic","longmemeval-flat-bm25"])
    args=parser.parse_args()
    if args.limit<0 or args.workers<1 or args.workers>8:
        raise ValueError("invalid limit/concurrency")
    out=Path(args.out).resolve()
    require_disk(out, incoming_bytes=8*1024**3)
    out.mkdir()
    raw=DATA.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==DATA_SHA,"public data digest changed"
    rows=json.loads(raw)
    selection=None
    if args.selection:
        assert not args.limit,"choose a fixed selection or a limit"
        selection=json.loads(args.selection.read_text())
        assert selection["kind"]=="fixed-prior-error-diagnostic"
        selected_ids=[r["questionId"] for r in selection["items"]]
        assert len(selected_ids)==len(set(selected_ids))==50
        by_id={r["question_id"]:r for r in rows}
        rows=[by_id[qid] for qid in selected_ids]
    if args.limit:
        rows=rows[:args.limit]
    assert len({r['question_id'] for r in rows})==len(rows)
    assert len(set(args.agents))==len(args.agents)
    source_revision=subprocess.check_output(["git","rev-parse","HEAD"],cwd=UPSTREAM,text=True).strip()
    judge,judge_sha=load_function(UPSTREAM/"src/evaluation/evaluate_qa.py","get_anscheck_prompt")
    reader,reader_sha=load_function(UPSTREAM/"src/generation/run_generation.py","prepare_prompt",{"json":json})
    retrieve,retrieve_sha=load_function(UPSTREAM/"src/retrieval/run_retrieval.py","run_flat_retrieval",{"np":np,"BM25Okapi":BM25Okapi},"DenseRetrievalMaster")
    corpus_builder,corpus_sha=load_function(UPSTREAM/"src/retrieval/run_retrieval.py","process_item_flat_index")
    tokenizer=tiktoken.get_encoding("cl100k_base")
    manifest={
        "schemaVersion":1,"benchmark":"longmemeval-cleaned-s","track":"adapted-model-transport",
        "scope":"fixed-prior-error50-diagnostic" if selection else ("full-500" if len(rows)==500 else "preflight-subset"),
        "selection": {"sha256": hashlib.sha256(args.selection.read_bytes()).hexdigest(), "plan": selection} if selection else None,
        "datasetSha256":DATA_SHA,"upstreamRevision":source_revision,
        "readerFunctionSha256":reader_sha,"judgeFunctionSha256":judge_sha,
        "retrievalFunctionSha256":retrieve_sha,"corpusFunctionSha256":corpus_sha,
        "readerModel":MODEL,"judgeModel":MODEL,"judgeLabelRule":"yes substring, unchanged upstream",
        "nativeHistoryBudgetChars":12000,"bm25TopKSessions":10,"bm25MaxContextTokens":4000,
        "bm25Tokenizer":"cl100k_base","bm25Corpus":"user messages only, upstream session granularity",
        "transportLimitations":["OpenCode ACP serializes role messages; no exact sampling or max_tokens control", "DeepSeek replaces the published fixed GPT-4o judge; do not directly subtract published scores"],
        "agents":args.agents,
        "planned":[{"question_id":r["question_id"],"question_type":r["question_type"]} for r in rows],
        "reserveHostBytes":30*1024**3,
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "dependencyVersions": {"numpy":np.__version__,"rank-bm25":"0.2.2","tiktoken":"0.12.0"},
    }
    client=ModelClient(args.base)
    manifest["transport"]=client.health()
    assert manifest["transport"]["model"]==MODEL
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    (out/"runner.py").write_bytes(Path(__file__).read_bytes())
    if args.selection:(out/"selection.json").write_bytes(args.selection.read_bytes())

    def evaluate(entry):
        clean, history=sanitize(entry)
        # Neither private answer nor answer-session labels cross either subject boundary.
        if "longmemeval-flat-bm25" in manifest["agents"]:
            corpus,corpus_ids=[],[]
            for sid,date,session in zip(clean["haystack_session_ids"],clean["haystack_dates"],clean["haystack_sessions"]):
                texts,ids,_=corpus_builder(session,"session",sid,date)
                corpus.extend(texts);corpus_ids.extend(ids)
            rank=retrieve(None,clean["question"],"flat-bm25",corpus)
            clean["retrieval_results"]={"ranked_items":[{"corpus_id":corpus_ids[int(i)],"text":corpus[int(i)]} for i in rank]}
            baseline_prompt=reader(clean,"flat-session",10,False,"json",False,tokenizer,"openai",4000,"none")
        results=[]
        # Order alternates by immutable ID hash to reduce systematic time/order effects.
        agents=list(manifest["agents"])
        if int(hashlib.sha256(entry["question_id"].encode()).hexdigest(),16)%2:
            agents.reverse()
        for agent in agents:
            require_disk(out)
            started=time.monotonic()
            result={"question_id":entry["question_id"],"question_type":entry["question_type"],"agent":agent,"status":"error","correct":None,"evidence":[],"costUsd":None}
            try:
                if agent=="mentat-episodic":
                    response=client.subject(history,f"Current Date: {entry['question_date']}\nQuestion: {entry['question']}\nAnswer based on relevant historical observations.")
                    hypothesis=response["text"]
                else:
                    hypothesis,response=client.complete(baseline_prompt)
                observation,path=verification(response)
                result.update(hypothesis=hypothesis,finalAnswerValid=not response.get("finalAnswerIssue"),finalAnswerIssue=response.get("finalAnswerIssue"))
                if response.get("retrieval"):
                    selection_info=response["retrieval"]
                    selected_sessions={json.loads(p.partition("#msg")[0][len("history:"):])[1] for p in selection_info["selectedIds"]}
                    gold=set(entry["answer_session_ids"])
                    expected={f"session-{i:04d}" for i,sid in enumerate(entry["haystack_session_ids"]) if sid in gold}
                    # Gold is controller-only. Session coverage is a coarse diagnostic,
                    # not proof that the selected message contains the answer.
                    eligible=bool(expected) and not entry["question_id"].endswith("_abs")
                    result.update(retrieval=selection_info,supportSessionRecall=len(expected & selected_sessions)/len(expected) if eligible else None,
                                  allSupportSessionsRetrieved=expected <= selected_sessions if eligible else None)
                result["evidence"].append(path)
                text,judged=client.complete(judge(entry["question_type"],entry["question"],entry["answer"],hypothesis,abstention=entry["question_id"].endswith("_abs")))
                judge_observation,judge_path=verification(judged)
                costs=[observation["costUsd"],judge_observation["costUsd"]]
                result.update(status="completed",correct="yes" in text.lower(),judgeResponse=text,judgeFormatValid=text.strip().lower().rstrip(".") in ["yes","no"],costUsd=sum(costs) if all(c is not None for c in costs) else None)
                result["usableCorrect"]=result["correct"] and result["finalAnswerValid"]
                result["evidence"].append(judge_path)
            except Exception as error:
                result["error"]=str(error)
            result["durationMs"]=int((time.monotonic()-started)*1000)
            results.append(result)
        return results

    completed=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool, (out/"results.jsonl").open("x") as stream:
        tasks={pool.submit(evaluate,row):row for row in rows}
        for future in concurrent.futures.as_completed(tasks):
            try:
                result=future.result()
            except Exception as error:
                row=tasks[future]
                result=[{"question_id":row["question_id"],"question_type":row["question_type"],"agent":agent,"status":"error","correct":None,"error":str(error),"costUsd":None,"durationMs":None,"evidence":[]} for agent in manifest["agents"]]
            for item in result:
                completed.append(item)
                stream.write(json.dumps(item,ensure_ascii=False)+"\n")
                stream.flush()
            print(json.dumps({"completed":len(completed),"planned":len(manifest["agents"])*len(rows),"last":result[0]["question_id"]}),flush=True)
    summaries={}
    for agent in manifest["agents"]:
        group=[r for r in completed if r["agent"]==agent]
        known=[r for r in group if r["correct"] is not None]
        by_type=defaultdict(list)
        for row in known:by_type[row["question_type"]].append(int(row["correct"]))
        abstentions=[r for r in known if r["question_id"].endswith("_abs")]
        summaries[agent]={"planned":len(rows),"status":dict(Counter(r["status"] for r in group)),"measured":len(known),"unknown":len(rows)-len(known),"accuracyObserved":sum(r["correct"] for r in known)/len(known) if known else None,"taskMacroObserved":float(np.mean([np.mean(v) for v in by_type.values()])) if by_type else None,"abstentionObserved":sum(r["correct"] for r in abstentions)/len(abstentions) if abstentions else None,"byType":{k:{"measured":len(v),"correct":sum(v),"accuracy":float(np.mean(v))} for k,v in by_type.items()},"costUsdKnown":sum(r["costUsd"] or 0 for r in group),"unknownCostTasks":sum(r["costUsd"] is None for r in group)}
    (out/"summary.json").write_text(json.dumps({"manifest":manifest,"agents":summaries},indent=2)+"\n")
    if any(s["unknown"] for s in summaries.values()):raise SystemExit(1)


if __name__=="__main__":
    main()
