"""Compare complete, identical reset rosters without filtering bad outcomes."""
import argparse
import json
from pathlib import Path
from statistics import mean

ROOT=Path(__file__).resolve().parents[2]

def read_rows(run, arm="reset"):
    plan=json.loads((run/'plan.json').read_text())
    roster={(r['family'],r['taskId']) for r in plan['roster'] if r['arm']==arm}
    rows=[json.loads(l) for l in (run/'results.jsonl').read_text().splitlines() if l]
    rows=[r for r in rows if r['arm']==arm]
    for row in rows:
        if row['status']=='completed': continue
        trial=run/'trials'/row['family'].split('/')[-1]/row['arm']/f"{row['index']:02d}"
        trace=trial/'upstream-trace.jsonl'
        if trace.exists(): row['tool_dispatch_count']=sum(json.loads(line)['type']=='tool_dispatch' for line in trace.read_text().splitlines() if line)
        response=trial/'subject/response.json'
        if response.exists(): row['costUsd']=json.loads(response.read_text())['observations']['costUsd']
    found={(r['family'],r['taskId']) for r in rows}
    assert len(found)==len(rows) and found<=roster,'duplicate/unplanned rows'
    return plan,roster,rows

def stats(roster,rows):
    by_key={(r['family'],r['taskId']):r for r in rows}
    assert set(by_key)==roster,'incomplete roster; do not report a final score'
    errors=[r for r in rows if r['status']!='completed']
    assert all('turn timed out' in r.get('error','') for r in errors),'unresolved infrastructure error'
    scored=[r for r in rows if r['status']=='completed']
    score=lambda r: r['task_score'] if r['status']=='completed' else 0.0
    evals=[r for r in rows if r['bucket']=='evaluation']
    families={f:mean(score(r) for r in evals if r['family']==f) for f in sorted({r['family'] for r in evals})}
    capabilities={c:mean(v for f,v in families.items() if f.split('/')[0]==c) for c in sorted({f.split('/')[0] for f in families})}
    return {'planned':len(roster),'scored':len(scored),'budgetTimeouts':len(errors),
            'allTaskMean100':100*mean(score(r) for r in rows),
            'evaluationPlanned':len(evals),'evaluationMean100':100*mean(score(r) for r in evals),
            'coveredCapabilityEvaluationMacro100':100*mean(capabilities.values()),
            'evaluationFamilies100':{k:100*v for k,v in families.items()},
            'coveredCapabilities100':{k:100*v for k,v in capabilities.items()},
            'validFinalAnswers':sum(r['validFinalAnswer'] for r in scored),
            'evaluationValidFinalAnswers':sum(r['validFinalAnswer'] for r in evals if r['status']=='completed'),
            'strictPasses':sum(r['passed'] for r in scored),
            'evaluationStrictPasses':sum(r['passed'] for r in evals if r['status']=='completed'),
            'episodesWithEnvironmentDispatch':sum(r.get('tool_dispatch_count',0)>0 for r in rows),
            'evaluationEpisodesWithEnvironmentDispatch':sum(r.get('tool_dispatch_count',0)>0 for r in evals),
            'environmentDispatches':sum(r.get('tool_dispatch_count',0) for r in rows),
            'costUsdScored':sum(r.get('costUsd',0) for r in scored),
            'costUsdAllAttempts':sum(r.get('costUsd') or 0 for r in rows),
            'cases':[{'taskId':r['taskId'],'family':r['family'],'bucket':r['bucket'],'status':r['status'],'score100':100*score(r),'validFinalAnswer':r.get('validFinalAnswer',False)} for r in rows]}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--run',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    old,roster,before=read_rows(ROOT/'.mentat/public-evaluations/past-rsi-20261019-v2')
    new,new_roster,after=read_rows(args.run)
    if new.get("selectedBuckets"):
        buckets=set(new["selectedBuckets"])
        before=[r for r in before if r["bucket"] in buckets]
        roster={(r["family"],r["taskId"]) for r in old["roster"] if r["arm"]=="reset" and r["episode"]["bucket"] in buckets}
    assert roster==new_roster and old['model']==new['model']
    assert old['datasetHashes']==new['datasetHashes'] and old['upstreamScorerSourceHashes']==new['upstreamScorerSourceHashes']
    result={'protocol':'matched-fixed-roster-foundation-comparison-v2','model':new['model'],
            'baselineProtocol':old['protocol'],'newProtocol':new['protocol'],
            'before':stats(roster,before),'after':stats(roster,after),
            'limits':['Adapted subset: 4 families across 2 capabilities, not complete official PAST Overall',
                      'One repetition per task; no statistical confidence interval',
                      'Missing judge in both arms; no score inflation by filling judge points',
                      'All pre-registered matched tasks retained; budget failures score zero',
                      'Fixed model, task prompts, schemas, grader and budgets; framework/tool capabilities differ',
                      'Task score and strict pass are separate; this does not establish RSI']}
    result['deltaAllMean100']=result['after']['allTaskMean100']-result['before']['allTaskMean100']
    result['deltaEvaluationMacro100']=result['after']['coveredCapabilityEvaluationMacro100']-result['before']['coveredCapabilityEvaluationMacro100']
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in {'before','after'}},ensure_ascii=False,indent=2))
    print(json.dumps({'before':{k:v for k,v in result['before'].items() if k!='cases'},'after':{k:v for k,v in result['after'].items() if k!='cases'}},ensure_ascii=False,indent=2))
