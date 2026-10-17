"""Predeclared synthetic judge controls; never used as subject training inputs."""
import concurrent.futures
import json
from pathlib import Path
from client import ModelClient
from upstream import load_function

ROOT=Path(__file__).resolve().parents[2]
prompt,source_hash=load_function(ROOT/".mentat/upstream/longmemeval/src/evaluation/evaluate_qa.py","get_anscheck_prompt")
fixtures=[]


def add(kind,question,reference,positive,negative):
    for index,response in enumerate(positive):
        fixtures.append({"id":f"{kind}-positive-{index}","type":kind,"question":question,"reference":reference,"hypothesis":response,"expected":True})
    for index,response in enumerate(negative):
        fixtures.append({"id":f"{kind}-negative-{index}","type":kind,"question":question,"reference":reference,"hypothesis":response,"expected":False})


add("single-session-user","What is my cat's name?","Luna",["Your cat is Luna.","Luna"],["Nori","I do not know."])
add("single-session-assistant","Which editor did you recommend?","Vim",["Vim.","I recommended Vim."],["Emacs.","A modern editor."])
add("multi-session","Which two cities did I visit?","Paris and Tokyo",["Paris and Tokyo.","You visited Tokyo as well as Paris."],["Paris.","London and Paris."])
add("knowledge-update","How many engineers do I lead now?","5",["Five engineers.","You previously led four; now you lead five."],["You lead four.","I cannot tell."])
add("temporal-reasoning","How many days elapsed?","30 days",["30 days.","31 days, counting both endpoints."],["45 days.","I do not know."])
add("single-session-preference","Suggest a dinner based on my garden.","Use the user's homegrown cherry tomatoes, basil or mint.",["Try pasta with your cherry tomatoes and basil.","Make a salad with your garden tomatoes and mint."],["I do not remember your garden. Order a burger.","Get a plain steak; no garden produce is needed."])
for index,(answer,expected) in enumerate([
    ("The history does not say what your sister's cat is named.",True),
    ("Insufficient information to determine that.",True),
    ("Your sister's cat is Luna.",False),
    ("It must be Nori.",False),
]):
    fixtures.append({"id":f"abstention-{index}","type":"single-session-user","question":"What is my sister's cat named?","reference":"Only the user's own cat is named; the sister's cat is not mentioned.","hypothesis":answer,"expected":expected,"abstention":True})


def evaluate(fixture):
    text,raw=ModelClient().complete(prompt(fixture["type"],fixture["question"],fixture["reference"],fixture["hypothesis"],abstention=fixture.get("abstention",False)))
    label="yes" in text.lower()
    return {**fixture,"judgeResponse":text,"label":label,"passed":label==fixture["expected"],"evidence":raw["mentat"]}


if __name__=="__main__":
    out=ROOT/".mentat/public-evaluations/judge-calibration-v1"
    out.mkdir()
    (out/"fixtures.json").write_text(json.dumps(fixtures,indent=2)+"\n")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(evaluate,fixtures))
    result={"scorerFunctionSha256":source_hash,"passed":sum(r["passed"] for r in results),"planned":len(results),"results":results,"scope":"Synthetic non-blind controls; not a guarantee of unbiased benchmark judging."}
    (out/"results.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({k:v for k,v in result.items() if k!="results"}))
    if result["passed"]!=result["planned"]:raise SystemExit(1)
