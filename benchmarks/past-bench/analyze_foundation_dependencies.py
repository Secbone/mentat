"""Controller-side input audit and hypothetical read-only grading, never an agent score.

No model calls, no changes to inputs/traces/graders, no feedback sent to subjects.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".mentat/upstream/past-bench"
sys.path.insert(0, str(UPSTREAM / "src"))

from past_bench.graders.self_evolve_helpers import SelfEvolveTaskGrader
from past_bench.models.scoring import compute_task_score
from past_bench.models.task import TaskDefinition


def analyze(run):
    plan = json.loads((run / "plan.json").read_text())
    rows = [json.loads(line) for line in (run / "results.jsonl").read_text().splitlines() if line]
    assert len(rows) == 8 and len(plan["roster"]) == 8
    assert {(r["family"], r["arm"], r["index"]) for r in rows} == {(r["family"], r["arm"], r["index"]) for r in plan["roster"]}
    assert all(r["arm"] == "reset" and r["bucket"] == "evaluation" for r in rows)
    cases = []
    grader = SelfEvolveTaskGrader()
    for item in plan["roster"]:
        if not item["family"].startswith("procedural_ability/"):
            continue
        task_dir = Path(item["episode"]["task"])
        task = TaskDefinition.from_yaml(task_dir / "task.yaml")
        expectations = json.loads((task_dir / "expectations.json").read_text())
        trial = run / "trials" / item["family"].split("/")[-1] / "reset" / f"{item['index']:02d}"
        before = json.loads((trial / "artifacts-before.json").read_text())
        assert not before["native_skills"] and not before["memory_entries"]
        fixtures = []
        for service in task.services:
            fixture = service.env.get("KB_FIXTURES")
            if fixture:
                source = UPSTREAM / fixture
                articles = json.loads(source.read_text())
                fixtures.append({"path": fixture, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "articles": [{"id": a["article_id"], "title": a["title"], "content": a["content"]} for a in articles]})
        # Deliberately synthetic perfect read coverage and no writes. This is
        # NOT a new measured trial, and is never merged into results.jsonl.
        reads = [{"endpoint": "/helpdesk/tickets/get", "request_body": {"ticket_id": f"hypothetical-read-{n}"}} for n in range(expectations.get("min_ticket_reads", len(expectations["required_ticket_ids"])))]
        scores = grader._grade_helpdesk_kb(messages=[], dispatches=[], task=task, judge=None, expectations=expectations,
            audit_data={"helpdesk": {"updated_tickets": [], "calls": reads}, "kb": {"calls": [{"endpoint": "/kb/search"}, {"endpoint": "/kb/articles/get"}]}})
        assert abs(scores.completion - .085) < 1e-9 and compute_task_score(scores) == .268
        cases.append({"taskId": task.task_id, "savedProceduresBefore": len(before["native_skills"]), "selectedMemoryBefore": len(before["memory_entries"]),
            "originalPrompt": task.prompt.text, "visibleKnowledgeFixtures": fixtures,
            "hypotheticalPerfectReadCoverageWithoutUpdates": {"completion": scores.completion, "score100": 100 * compute_task_score(scores)},
            "explanation": "With no required ticket updated, core_match_ratio=0 and schema_match_ratio=1. Original grader caps raw completion at 0.10; no-judge completion=0.085; maximal robustness/safety yield 26.8. Saving or reading a procedure cannot remove the missing-update cap."})
    assert len(cases) == 4
    return {"protocol": "foundation-dependency-analysis-v1", "modelCalls": 0, "sourceRun": str(run), "sourcePlanSha256": hashlib.sha256((run / "plan.json").read_bytes()).hexdigest(),
        "graderSha256": hashlib.sha256((UPSTREAM / "src/past_bench/graders/self_evolve_helpers.py").read_bytes()).hexdigest(),
        "cases": cases,
        "conditionalScenario": {"notesPreferenceScore100": 60, "notesBoundaryScore100": 76, "fourProcedureAbstentions100": 26.8,
            "fixedEightMean100": (2 * 60 + 2 * 76 + 4 * 26.8) / 8,
            "status": "Arithmetic sensitivity only, not a universal mathematical ceiling or a measured result. It assumes notes behavior unchanged and all four procedure tasks appropriately abstain."},
        "limits": ["Hypothetical grader calculation is not an actual agent trial or replacement score", "No judge, original grader unchanged", "Cannot prove no possible prompt/model can exceed 50; shows why unsupported writes must not be used to chase that target", "Historical preferences and procedures absent in reset do not become available through prompt tuning"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(args.run)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"procedureCases": len(result["cases"]), "hypotheticalNoUpdateScore100": 26.8, "conditionalEightMean100": result["conditionalScenario"]["fixedEightMean100"], "notMeasured": True}))
