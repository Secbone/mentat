"""Derive an auditable summary of the fixed OpenViking integration diagnostic."""
import argparse
import hashlib
import json
import statistics
from pathlib import Path

from audit_text_transport import payload
from longmemeval import DATA, DATA_SHA


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((args.run/"manifest.json").read_text())
    raw_results = (args.run/"results.jsonl").read_bytes()
    rows = [json.loads(line) for line in raw_results.splitlines()]
    assert len(rows) == 30 and len({(r['question_id'],r['arm']) for r in rows}) == 30
    assert all(r['status']=='completed' and r['judgeFormatValid'] for r in rows)
    raw = DATA.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == DATA_SHA
    entries = {r['question_id']:r for r in json.loads(raw)}
    audit = json.loads(args.audit.read_text())
    assert audit['recordedToolPolicy']=='passed' and audit['counts']['requests']==60
    models, cases, totals = set(), [], {}
    for row in rows:
        entry = entries[row['question_id']]
        marked = {(f'session-{i:04d}',j) for i,s in enumerate(entry['haystack_sessions'])
                  for j,m in enumerate(s) if m.get('has_answer')}
        response = json.loads(Path(row['evidence'][0]).read_text())
        observed = response['observations']
        if row['arm']=='mentat-current':
            selected = set()
            directory = Path(response['evidenceDir'])
            for line in (directory/'events.jsonl').read_text().splitlines():
                event = json.loads(line)
                if event['type']=='history.selection':
                    selection = payload(directory,event)
                    selected = {(m['session'],int(m['pointer'].split('#msg')[1].split(':')[0]))
                                for m in map(json.loads,selection['text'].splitlines())}
            matched = len(marked & selected)
        else:
            matched = row['markedMessagesRetrieved']
        record = {k:row[k] for k in ['question_id','question_type','arm','correct','durationMs']}
        record.update(finalAnswerValid=not row.get('finalAnswerIssue'),
            usableCorrect=bool(row['correct'] and not row.get('finalAnswerIssue')),
            firstAnswerValid=response['firstAnswerValid'],correctiveTurns=response['correctiveTurns'],
            annotatedSupportMessages=len(marked),retrievedAnnotatedMessages=matched,
            allAnnotatedMessagesRetrieved=matched==len(marked) if marked and not row['question_id'].endswith('_abs') else None,
            readerInputTokens=sum(s['tokens_input'] for s in observed['accounting']['sessions']))
        cost = 0.0
        for evidence in row['evidence']:
            obs = json.loads(Path(evidence).read_text())['observations']
            assert obs['costUsd'] is not None
            cost += obs['costUsd']
            models.update(m['effective'] for m in obs['models'])
        record['costUsd'] = cost
        cases.append(record)
    assert models == {manifest['model']}
    for arm in manifest['arms']:
        group = [r for r in cases if r['arm']==arm]
        answerable = [r for r in group if not r['question_id'].endswith('_abs')]
        abs_group = [r for r in group if r['question_id'].endswith('_abs')]
        totals[arm] = {'completed':len(group),'correct':sum(r['correct'] for r in group),
            'usableCorrect':sum(r['usableCorrect'] for r in group),
            'answerableCorrect':sum(r['correct'] for r in answerable),
            'abstentionCorrect':sum(r['correct'] for r in abs_group),
            'allAnnotatedMessagesRetrieved':sum(r['allAnnotatedMessagesRetrieved'] is True for r in answerable),
            'meanAnnotatedMessageRecall':statistics.mean(r['retrievedAnnotatedMessages']/r['annotatedSupportMessages'] for r in answerable if r['annotatedSupportMessages']),
            'costUsd':sum(r['costUsd'] for r in group),
            'meanReaderInputTokens':statistics.mean(r['readerInputTokens'] for r in group),
            'medianReaderAndJudgeMs':statistics.median(r['durationMs'] for r in group),
            'firstAnswerInvalid':sum(not r['firstAnswerValid'] for r in group),
            'correctiveTurns':sum(r['correctiveTurns'] for r in group)}
    report = {'scope':manifest['scope'], 'claimBoundary':'Selected diagnostic, 8 prior errors plus 2 prior successes; not a full benchmark or an evaluation of native memory extraction on LongMemEval.',
        'manifest':manifest,'resultsSha256':hashlib.sha256(raw_results).hexdigest(),
        'modelsVerified':sorted(models),'toolAudit':audit,'arms':totals,'caseResults':cases}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(totals,indent=2))


if __name__=='__main__':
    main()
