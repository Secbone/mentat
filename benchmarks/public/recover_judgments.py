"""Recover only pre-inference model-identity failures; never resample answers.

Original results remain immutable. Recovery reuses the exact saved hypothesis and
unchanged upstream judge prompt. Other failure classes are left unresolved.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
from client import ModelClient
from longmemeval import DATA, DATA_SHA, UPSTREAM, verification
from upstream import load_function


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--run",type=Path,required=True)
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    manifest=json.loads((args.run/"manifest.json").read_text())
    # Require a finished run; observation timeout is not permission to restart it.
    json.loads((args.run/"summary.json").read_text())
    raw=DATA.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==DATA_SHA==manifest["datasetSha256"]
    references={r["question_id"]:r for r in json.loads(raw)}
    judge,judge_hash=load_function(UPSTREAM/"src/evaluation/evaluate_qa.py","get_anscheck_prompt")
    assert judge_hash==manifest["judgeFunctionSha256"]
    client=ModelClient()
    health=client.health()
    for key in ["model","codeSha256","harness","samplingControl","messageDelivery"]:
        assert health[key]==manifest["transport"][key],f"transport changed: {key}"
    args.out.mkdir()
    source=[json.loads(line) for line in (args.run/"results.jsonl").read_text().splitlines()]
    recovered=[]
    for row in source:
        if row["status"]=="completed":
            continue
        if "ACP model mismatch" not in row.get("error","") or not row.get("hypothesis"):
            continue
        ref=references[row["question_id"]]
        started=time.monotonic()
        text,response=client.complete(judge(ref["question_type"],ref["question"],ref["answer"],row["hypothesis"],abstention=row["question_id"].endswith("_abs")))
        recovery_ms=int((time.monotonic()-started)*1000)
        observation,evidence=verification(response)
        # The original reader was already complete; its result is never regenerated.
        reader=json.loads(Path(row["evidence"][0]).read_text())
        reader_cost=reader["observations"]["costUsd"]
        recovered.append({
            "original":row,"replacement":{
                **row,"status":"completed","correct":"yes" in text.lower(),
                "judgeResponse":text,"judgeFormatValid":text.strip().lower().rstrip(".") in ["yes","no"],
                "error":None,"evidence":[*row["evidence"],evidence],
                "durationMs":(row["durationMs"] or 0)+recovery_ms,
                "costUsd":reader_cost+observation["costUsd"] if reader_cost is not None and observation["costUsd"] is not None else None,
            },"policy":"post-hoc infrastructure-only judge recovery; exact saved hypothesis; no answer resampling",
        })
    (args.out/"recoveries.json").write_text(json.dumps({"sourceRun":str(args.run.resolve()),"judgeFunctionSha256":judge_hash,"items":recovered},indent=2)+"\n")
    print(json.dumps({"originalErrors":sum(r["status"]!="completed" for r in source),"recovered":len(recovered)}))
