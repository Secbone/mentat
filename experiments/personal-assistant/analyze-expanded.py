"""Recheck expanded-run accounting/provenance and export the reviewed observations.

This script does not call a model. Behavior judgments are a targeted, non-blind
review of saved answers, not an automated overall accuracy benchmark.
"""
import json
from collections import Counter
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAIN = ROOT / '.mentat/experiments/personal-assistant/expanded-1791963400008'
DIAG = ROOT / '.mentat/experiments/personal-assistant/expanded-diagnostics-1791964672144'


def read(path):
    return json.loads(path.read_text())


def records(directory):
    return [d for p in directory.glob('*.json')
            if isinstance(d := read(p), dict) and 'first' in d and 'id' in d]


main, diag = records(MAIN), records(DIAG)
assert len(main) == 94 and len(diag) == 10
assert sum(bool(r.get('revision')) for r in main) == 12
reflected = [r for r in main if r.get('reflectionResult')]
assert len(reflected) == 12
candidate_count = 0
for r in reflected:
    assert r['reflectionResult']['status'] == 'ok'
    source_ids = {e['id'] for e in r['interactions']}
    for candidate in r['reflectionResult']['candidates']:
        assert candidate['evidenceIds']
        assert set(candidate['evidenceIds']) <= source_ids
        candidate_count += 1

sessions = []
cost = 0
for directory in [MAIN, DIAG]:
    sessions.extend(read(directory / 'verification.json')['sessions'])
    accounting = read(directory / 'accounting.json')
    cost += sum(r['cost'] for r in accounting)
    assert all(r['models'] == ['opencode-go/deepseek-v4.1-flash'] for r in accounting)
    assert all(s['engineVersion'] == '2.0.25' for r in accounting for s in r['sessions'])
assert all(s['actualModel'] == 'opencode-go/deepseek-v4.1-flash' for s in sessions)
assert len({s['session'] for s in sessions}) == 116

growth = {role: [len(read(MAIN / f'{role}-checkpoint-{n}.json')['memory'])
                  for n in ['03', '07', '09']]
          for role in ['teacher', 'finance', 'retail', 'designer']}
by_id = {r['id']: r for r in main + diag}

# Quotes are checked against saved first answers; interpretation is manual.
issues = [
    ('invented-action', 'retail-learned-09', '破损件已单独留存并拍照',
     '材料只有数量与破损数，没有完成拍照、留存或附件的证据。'),
    ('unconfirmed-classification', 'finance-learned-03', '两项一次性支出',
     '材料仅明确设备维护为一次性，招聘被自行归类。'),
    ('fraction-error', 'teacher-parent-identity-learned-1', '反而比 1/4 还小',
     '2/6=1/3>1/4；同一错误也出现在 cold-1。'),
    ('rounding-consistency', 'finance-cause-wanyuan', '仍有0.2万元缺口',
     '实际4.2万元减临时运费0.4万元=3.8万元，等于预算；摘要与后文矛盾。'),
    ('ratio-error', 'designer-learned-01', '9:16 竖版（1080×1440）',
     '1080:1440=3:4，与9:16不同。'),
    ('integer-break-even', 'retail-learned-01', '约 24 件才能打平',
     '170/7≈24.286；整件至少25件，且当前库存20件。'),
    ('discount-error', 'teacher-cold-08', '原价正好是 10 元',
     '八折与减8元相等需0.8p=p-8，即p=40，不是10。'),
    ('missing-hard-constraint', 'pressure-saturated-2', '唯一固定约束是',
     '规则仍在存储，但初始上下文遗漏11点硬约束；回答接受11:35结束。'),
]
observations = []
for category, artifact, quote, finding in issues:
    r = by_id[artifact]
    assert quote in r['first']['text'], artifact
    observations.append({'category': category, 'artifact': artifact,
                         'quote': quote, 'finding': finding})
assert Fraction(2, 6) > Fraction(1, 4)
assert Fraction(1080, 1440) != Fraction(9, 16)

retail = read(MAIN / 'retail-checkpoint-09.json')['memory']
contamination = [m for m in retail if m['id'] in ['mem-14juuc5', 'mem-13nmwj', 'mem-j47zdc']]
assert len(contamination) == 3
finance = read(MAIN / 'finance-checkpoint-09.json')['memory']
duplicate_ids = ['pref-chenyue-missing-data', 'mem-lf4o2e', 'mem-114eqri', 'mem-7zippy']
duplicates = [m for m in finance if m['id'] in duplicate_ids]
assert len(duplicates) == 4
pressure = [{k: v for k, v in r.items() if k != 'snapshot'}
            for r in read(MAIN / 'pressure-selection.json')]
profile_checks = [
    ('teacher-example-first', '实例先于规则'),
    ('teacher-definition-first', '定义先于实例；额外的比例判断有错误'),
    ('finance-cause-wanyuan', '原因先于表格、万元1位；摘要数字错误'),
    ('finance-table-yuan', '表格先于原因、元2位'),
    ('retail-short-50', '正文不超过50字'),
    ('retail-detailed-100-160', '正文100至160字'),
    ('designer-one-direction', '只给1个方向'),
    ('designer-two-directions', '给2个方向'),
]
lengths = {key: len(by_id[key]['first']['text'].strip())
           for key in ['retail-short-50', 'retail-detailed-100-160']}
assert lengths['retail-short-50'] <= 50
assert 100 <= lengths['retail-detailed-100-160'] <= 160
analysis = {
    'reviewMethod': 'targeted non-blind manual semantic review; no overall accuracy score',
    'counts': {'firstAnswers': 104, 'revisions': 12, 'reflections': 12,
               'hostPromptCalls': 128, 'wireSessions': 116,
               'nativeAssistantMessages': sum(s['assistantMessages'] for s in sessions),
               'reflectionCandidates': candidate_count},
    'model': 'opencode-go/deepseek-v4.1-flash', 'engineVersion': '2.0.25',
    'nativeSessionCostUsd': cost, 'accountingNote': 'reported session cost, not invoice',
    'mainRecordKinds': dict(Counter(r['kind'] for r in main)),
    'sourceIdChecks': 'all 12 reflections reference existing interaction records; endorsement NOT checked',
    'memoryGrowthAfterReflections': growth,
    'observations': observations, 'unconfirmedGeneralizations': contamination,
    'semanticDuplicateExample': duplicates, 'pressureSelection': pressure,
    'pressureManualReview': {'small': [True, True], 'grown': [True, True],
                             'tagged': [True, True], 'same-priority-saturation': [True, False]},
    'nativeRecoveryTrace': read(DIAG / 'native-retrieval-check.json'),
    'counterfactualProfileManualReview': [{'artifact': key, 'targetStyleObserved': True,
                                         'criterionAndCaveat': criterion}
                                        for key, criterion in profile_checks],
    'retailReplyLengthsIncludingPunctuation': lengths,
    'limits': ['four synthetic single learning trajectories', 'frozen-memory probe repeats',
               'manual profiles test responsiveness, not learning', 'artificial memory saturation',
               'ACP only; no true Pi model evaluation', 'no external sending or purchasing'],
}
destination = ROOT / 'experiments/personal-assistant/results/expanded-analysis-2026-10-14.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'output': str(destination), 'counts': analysis['counts'],
                  'costUsd': cost, 'growth': growth, 'replyLengths': lengths}, ensure_ascii=False))
