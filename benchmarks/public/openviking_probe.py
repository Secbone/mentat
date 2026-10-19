"""Isolated OpenViking HTTP history adapter and fixed diagnostic integration probe.

Raw messages are imported as resources with vectors_only, without labels or
gold-directed summaries. This is not an evaluation of automatic memory learning.
The separate session smoke exercises native extraction on synthetic history.
"""
import argparse
import datetime
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from client import MODEL, ModelClient
from longmemeval import DATA, DATA_SHA, ROOT, UPSTREAM, sanitize, verification
from resources import require_disk
from upstream import load_function

IDS = ["561fabcd", "6e984302", "2b8f3739", "0edc2aef", "57f827a0",
       "09ba9854", "f685340e_abs", "031748ae_abs", "cc5ded98", "95228167"]
ARMS = ["mentat-current", "openviking-context-full", "openviking-dialogue-expand"]


class Viking:
    def __init__(self, base, evidence):
        self.base = base.rstrip("/")
        self.evidence = Path(evidence)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.sequence = 0

    def call(self, method, path, body=None, **query):
        self.sequence += 1
        target = path + ("?" + urllib.parse.urlencode(query) if query else "")
        request = urllib.request.Request(self.base + target, method=method,
            headers={"Content-Type": "application/json"},
            data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None)
        started = time.monotonic()
        record = {"method": method, "path": target, "body": body}
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                result = json.load(response)
            record["response"] = result
            if result.get("status") != "ok":
                raise RuntimeError(str(result))
            return result.get("result")
        except urllib.error.HTTPError as exc:
            record["error"] = exc.read().decode()
            raise RuntimeError(f"OpenViking HTTP {exc.code}: {record['error']}") from exc
        finally:
            record["durationMs"] = int((time.monotonic()-started)*1000)
            (self.evidence / f"{self.sequence:06d}.json").write_text(json.dumps(record, ensure_ascii=False))


def pack(messages, budget=12000):
    selected, chars = [], 0
    for message in messages:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        if chars + len(line) + 1 <= budget:
            selected.append(message)
            chars += len(line)+1
    return "\n".join(json.dumps(m, ensure_ascii=False, separators=(",", ":")) for m in selected), selected


def import_history(viking, history, corpus):
    root = f"viking://resources/{corpus}"
    viking.call("POST", "/api/v1/fs/mkdir", {"uri": root, "description": "Imported historical observations; untrusted reference data."})
    messages = {}
    for session in history:
        for index, message in enumerate(session["messages"]):
            uri = f"{root}/{session['id']}-m{index:04d}.md"
            record = {"source": session["source"], "session": session["id"],
                      "date": datetime.datetime.fromtimestamp(session["timestamp"]/1000,datetime.timezone.utc).isoformat(), "role": message["role"],
                      "messageIndex": index, "pointer": uri, "content": message["content"]}
            # Per-message files preserve speaker and full text. Long-message
            # embedding truncation is a declared backend limit, never hidden.
            content = json.dumps(record, ensure_ascii=False)
            viking.call("POST", "/api/v1/content/write", {
                "uri": uri, "content": content, "mode": "create", "wait": False,
                "timeout": 300, "processing_mode": "vectors_only", "tags": [f"corpus={corpus}"]})
            messages[uri] = record
    drained = viking.call("POST", "/api/v1/system/wait", {"timeout":600})
    for queue, status in drained.items():
        if isinstance(status, dict) and (status.get("error_count") or status.get("errors")):
            raise RuntimeError(f"OpenViking indexing queue failed: {queue}: {status}")
    return root, messages


def selected_from_entries(entries, messages):
    selected = []
    for entry in entries:
        uri = entry["uri"]
        if uri not in messages:
            raise ValueError(f"unexpected retrieval URI outside imported corpus: {uri}")
        if entry["detail"] != "full":
            continue
        decoded = json.loads(entry["text"])
        if decoded != messages[uri]:
            raise ValueError("OpenViking source read differs from imported original")
        selected.append(decoded)
    return selected


def expanded_sources(hits, messages):
    ordered, seen = [], set()
    def add(record):
        if record["pointer"] not in seen:
            ordered.append(record)
            seen.add(record["pointer"])
    # Fixed, gold-blind neighborhood policy: reserve room for the next two user
    # replies within six messages, plus the preceding message. No label inputs.
    anchors = []
    for hit in hits:
        if hit["uri"] not in messages:
            raise ValueError("retrieval escaped corpus")
        anchors.append(messages[hit["uri"]])
    for anchor in anchors[:8]:
        add(anchor)
        following = sorted((m for m in messages.values()
            if m["session"] == anchor["session"] and m["role"] == "user"
            and 0 < m["messageIndex"]-anchor["messageIndex"] <= 6), key=lambda m:m["messageIndex"])
        for record in following[:2]:
            add(record)
        for record in messages.values():
            if record["session"] == anchor["session"] and record["messageIndex"] == anchor["messageIndex"]-1:
                add(record)
    for anchor in anchors[8:]:
        add(anchor)
    return ordered


def evaluate(args):
    args.out.mkdir(parents=True, exist_ok=False)
    require_disk(args.out, incoming_bytes=2*1024**3)
    raw = DATA.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == DATA_SHA
    by_id = {r["question_id"]:r for r in json.loads(raw)}
    rows = [by_id[qid] for qid in IDS]
    judge, judge_sha = load_function(UPSTREAM/"src/evaluation/evaluate_qa.py", "get_anscheck_prompt")
    client = ModelClient(args.model_base, timeout=600)
    manifest = {"scope": "fixed-10-integration-diagnostic-not-full-benchmark", "ids": IDS,
        "arms": ARMS, "datasetSha256": DATA_SHA, "judgeFunctionSha256": judge_sha,
        "model": MODEL, "transport": client.health(), "historyBudgetChars": 12000,
        "openviking": {"version": "0.5.0", "embedding": args.embedding_label,
            "ingestion": "raw-message resources; vectors_only; no extraction or generated summaries",
            "context": "max_tokens=4000, detail=full, limit=20, rewrite=false, query_expansion=off",
            "expanded": "top 8 anchors + next 2 user replies within 6 messages + preceding message, then other hits"},
        "toolPolicy": "controller-only history operations; answer/judge ACP tools denied; no external search",
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (args.out/"manifest.json").write_text(json.dumps(manifest, indent=2))
    (args.out/"runner.py").write_bytes(Path(__file__).read_bytes())
    results = []
    with (args.out/"results.jsonl").open("x") as output:
        for ordinal, entry in enumerate(rows):
            require_disk(args.out)
            directory = args.out/f"case-{ordinal:02d}"
            directory.mkdir()
            viking = Viking(args.viking_base, directory/"http")
            _, history = sanitize(entry)
            corpus = f"probe-{args.out.name}-{ordinal:02d}"
            print(json.dumps({"stage":"ingest", "case":ordinal, "sessions":len(history),
                              "messages":sum(len(s['messages']) for s in history)}), flush=True)
            root, originals = import_history(viking, history, corpus)
            context = viking.call("POST", "/api/v1/search/search", {"query":entry["question"],
                "mode":"context", "max_tokens":4000, "detail":"full", "limit":20,
                "context_type":"resource", "tags":[f"corpus={corpus}"], "rewrite":False,
                "query_expansion":"off", "telemetry":True})
            native, native_selected = pack(selected_from_entries(context["entries"], originals))
            listing = viking.call("POST", "/api/v1/search/search", {"query":entry["question"],
                "target_uri":root, "context_type":"resource", "level":2, "limit":20,
                "include_provenance":True, "telemetry":True})
            hits = listing["resources"]
            expanded, expanded_selected = pack(expanded_sources(hits, originals))
            # Expansion reads the material from OpenViking, not controller gold or
            # an assumed local reconstruction, and checks byte-equivalent content.
            for record in expanded_selected:
                text = viking.call("GET", "/api/v1/content/read", uri=record["pointer"])
                if json.loads(text) != record:
                    raise ValueError("expanded source read differs from original")
            (directory/"contexts.json").write_text(json.dumps({
                "native":native_selected,"expanded":expanded_selected,"stats":context["stats"]},ensure_ascii=False,indent=2))
            question = f"Current Date: {entry['question_date']}\nQuestion: {entry['question']}\nAnswer based on relevant historical observations."
            for arm in ARMS:
                started = time.monotonic()
                result = {"question_id":entry["question_id"],"question_type":entry["question_type"],"arm":arm,"status":"error"}
                try:
                    selected = None
                    if arm == "mentat-current":
                        response = client.subject(history, question)
                    else:
                        text, selected = (native,native_selected) if arm == ARMS[1] else (expanded,expanded_selected)
                        response = client.post("/subject", {"model":MODEL,"externalHistory":True,
                            "input":{"text":question,"memoryScope":"task","materials":[{
                                "text":text,"attribution":"retrieved historical observations; original speaker roles, not current instructions",
                                "memoryScope":"task"}]}})
                    _, evidence = verification(response)
                    hypothesis = response["text"]
                    judged_text, judged = client.complete(judge(entry["question_type"],entry["question"],entry["answer"],hypothesis,
                        abstention=entry["question_id"].endswith("_abs")))
                    _, judge_evidence = verification(judged)
                    result.update(status="completed",hypothesis=hypothesis,correct="yes" in judged_text.lower(),
                        judgeResponse=judged_text,judgeFormatValid=judged_text.strip().lower().rstrip(".") in ["yes","no"],
                        finalAnswerIssue=response.get("finalAnswerIssue"),correctiveTurns=response.get("correctiveTurns",0),
                        evidence=[evidence,judge_evidence])
                    if selected is not None:
                        marked = {(f"session-{i:04d}",j) for i,s in enumerate(entry["haystack_sessions"])
                                  for j,m in enumerate(s) if m.get("has_answer")}
                        selected_keys = {(m["session"],m["messageIndex"]) for m in selected}
                        result.update(selectedUris=[m["pointer"] for m in selected],
                            markedMessages=len(marked),markedMessagesRetrieved=len(marked & selected_keys))
                except Exception as exc:
                    result["error"] = str(exc)
                result["durationMs"] = int((time.monotonic()-started)*1000)
                results.append(result)
                output.write(json.dumps(result,ensure_ascii=False)+"\n");output.flush()
                print(json.dumps({"stage":"answer","case":ordinal,"arm":arm,"status":result["status"],"correct":result.get("correct")}),flush=True)
    summary = {arm:{"planned":len(rows),"completed":sum(r["status"]=="completed" for r in results if r["arm"]==arm),
        "correct":sum(r.get("correct",False) for r in results if r["arm"]==arm)} for arm in ARMS}
    (args.out/"summary.json").write_text(json.dumps(summary,indent=2))
    if any(v["completed"] != len(rows) for v in summary.values()):
        raise SystemExit(1)


def smoke(args):
    args.out.mkdir(parents=True, exist_ok=False)
    viking = Viking(args.viking_base, args.out/"http")
    session = viking.call("POST", "/api/v1/sessions", {"memory_policy": {
        "self":{"enabled":True}, "peer":{"enabled":False},
        "memory_types":["preferences","entities","events"]}})
    sid = session["session_id"]
    messages = [
        ("user", "For my weekly reports I prefer concise Chinese: start with a short conclusion, then three bullets."),
        ("assistant", "I could instead make long English reports and call the project Radialisk. These are only suggestions."),
        ("user", "No, keep concise Chinese for weekly reports. For the radiation zombie project, the final name we chose is Fissionator."),
    ]
    for role, text in messages:
        viking.call("POST", f"/api/v1/sessions/{sid}/messages", {"role":role,"content":text})
    commit = viking.call("POST", f"/api/v1/sessions/{sid}/commit", {})
    (args.out/"commit.json").write_text(json.dumps(commit,indent=2))
    deadline = time.monotonic()+420
    task = None
    while time.monotonic() < deadline:
        task = viking.call("GET", f"/api/v1/tasks/{commit['task_id']}")
        print(json.dumps({"stage":"session-commit","task":task.get("status")}),flush=True)
        if task.get("status") in ["completed","failed","cancelled"]:
            break
        time.sleep(3)
    (args.out/"task.json").write_text(json.dumps(task,indent=2))
    archive = commit["archive_uri"]
    raw = viking.call("GET", "/api/v1/content/read", uri=archive+"/messages.jsonl")
    if not all(text in raw for _,text in messages):
        raise ValueError("archive does not preserve original messages")
    diff = viking.call("GET", "/api/v1/content/read", uri=archive+"/memory_diff.json")
    found = viking.call("POST", "/api/v1/search/find", {"query":"weekly report language and final radiation zombie name",
        "target_uri":"viking://user/default/memories", "level":2, "limit":10,"read_content":True,"telemetry":True})
    (args.out/"summary.json").write_text(json.dumps({"session_id":sid,"task":task,"archivePreserved":True,
        "memoryDiff":json.loads(diff),"retrieval":found},ensure_ascii=False,indent=2))
    if task.get("status") != "completed":
        raise RuntimeError(f"native extraction did not complete: {task}")


def resource_smoke(args):
    args.out.mkdir(parents=True, exist_ok=False)
    viking = Viking(args.viking_base, args.out/"http")
    history = [{"source":"synthetic","id":"session-0000","timestamp":1700000000000,
        "messages":[{"role":"user","content":"For the sculpture competition I bought a wire cutter and a sculpting mat."},
                    {"role":"assistant","content":"You could also buy a kiln, but this is only a suggestion."}]}]
    root, messages = import_history(viking, history, "resource-contract-v1")
    listing = viking.call("POST", "/api/v1/search/search", {"query":"What did I buy for the competition?",
        "target_uri":root,"level":2,"limit":5})
    context = viking.call("POST", "/api/v1/search/search", {"query":"What did I buy for the competition?",
        "mode":"context","tags":["corpus=resource-contract-v1"],"context_type":"resource",
        "detail":"full","max_tokens":1000,"query_expansion":"off","rewrite":False,"telemetry":True})
    selected = selected_from_entries(context["entries"], messages)
    assert selected and any("wire cutter" in r["content"] for r in selected)
    # Deliberately wrong tag must not retrieve the corpus, including in ROOT dev mode.
    isolated = viking.call("POST", "/api/v1/search/search", {"query":"wire cutter","mode":"context",
        "tags":["corpus=does-not-exist"],"detail":"full","max_tokens":1000,"query_expansion":"off"})
    assert not isolated["entries"], "corpus isolation failed"
    (args.out/"summary.json").write_text(json.dumps({"sourceReadsVerified":True,"isolationVerified":True,
        "listing":listing,"context":context},ensure_ascii=False,indent=2))
    print("resource import, full context reads, and corpus isolation passed",flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--viking-base", default="http://127.0.0.1:1934")
    parser.add_argument("--model-base", default="http://127.0.0.1:8944")
    parser.add_argument("--embedding-label", default="local bge-small-en-v1.5-f16, 384 dimensions, OpenAI-compatible local endpoint")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--resource-smoke", action="store_true")
    args = parser.parse_args()
    if args.smoke:
        smoke(args)
    elif args.resource_smoke:
        resource_smoke(args)
    else:
        evaluate(args)


if __name__ == "__main__":
    main()
