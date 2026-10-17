"""Analyze immutable pilot inputs; write separate exploratory diagnostics."""
import hashlib
import json
import re
import statistics
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / ".mentat/benchmarks/unified-20261016"
DEST = ROOT / "benchmarks/pilots/2026-10-16/results.json"


def stat(values):
    return {"sum": sum(values), "measured": len(values), "mean": statistics.mean(values)}


def matches(value, rule):
    actual = value
    for part in rule["path"]:
        if not isinstance(actual, dict) or part not in actual:
            return False
        actual = actual[part]
    return (
        rule["op"] == "eq"
        and json.dumps(actual, sort_keys=True) == json.dumps(rule["value"], sort_keys=True)
    )


def analyze(name):
    directory = RUNS / name
    run = json.loads((directory / "run.json").read_text())
    data = json.loads((directory / "dataset.json").read_text())
    phases = {e["id"]: e["phase"] for e in data["episodes"]}
    episodes = {e["id"]: e for e in data["episodes"]}
    groups = defaultdict(list)
    for row in run["results"]:
        groups[row["arm"]].append(row)
    arms = {}
    for arm, rows in groups.items():
        scores = defaultdict(list)
        by_phase = defaultdict(lambda: defaultdict(list))
        invalid_json, pseudo_tools = [], []
        fenced_recoveries, correction_repairs = [], []
        audits, models, sessions, reflections = [], [], [], []
        for row in rows:
            for key, measurement in row["metrics"].items():
                if measurement["value"] is not None:
                    scores[key].append(measurement["value"])
                    by_phase[phases[row["caseId"]]][key].append(measurement["value"])
            observations = row.get("observations", {})
            models.extend(observations.get("models", []))
            sessions.extend(observations.get("nativeSessionIds", []))
            if "reflection" in row:
                reflections.append({"caseId": row["caseId"], **row["reflection"]})
            for evidence in row["evidence"]:
                if evidence.endswith("turn-0.json"):
                    text = json.loads(Path(evidence).read_text())["result"]["text"]
                    try:
                        json.loads(text)
                    except ValueError:
                        invalid_json.append(row["caseId"])
                        fence = re.fullmatch(r"\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*", text)
                        if fence:
                            try:
                                value = json.loads(fence.group(1))
                                recovered = {}
                                for c in episodes[row["caseId"]]["checks"]:
                                    if c["kind"] != "json-criteria":
                                        continue
                                    rules = json.loads(c["expected"])["all"]
                                    recovered[c["metricId"]] = int(all(matches(value, rule) for rule in rules))
                                fenced_recoveries.append({"caseId":row["caseId"],"metrics":recovered})
                            except (ValueError, TypeError):
                                pass
                    if "DSML" in text or "memory_search" in text:
                        pseudo_tools.append(row["caseId"])
                if evidence.endswith("turn-1.json"):
                    text = json.loads(Path(evidence).read_text())["result"]["text"]
                    try:
                        value = json.loads(text)
                        expected = episodes[row["caseId"]]["turns"][1]["when"]["unless"]["all"][0]["value"]
                        correction_repairs.append({"caseId":row["caseId"],"strictJson":True,"orderRepaired":value.get("order")==expected})
                    except (ValueError,AttributeError):
                        correction_repairs.append({"caseId":row["caseId"],"strictJson":False,"orderRepaired":False})
                if evidence.endswith("verification.json"):
                    trial = Path(evidence).parent
                    entries = json.loads((trial / "memory-after.json").read_text())
                    unexpected = [e for e in entries if e.get("status")=="active" and e.get("basis")!="user"]
                    quoted_active = [e for e in entries if e.get("status")=="active" and "别人的格式" in e.get("text", "")]
                    bad_origins = [
                        e for e in entries if e.get("status")=="active" and (
                            e.get("speaker")!="user" or not e.get("evidenceSources")
                            or any(s.get("origin")!="user" for s in e.get("evidenceSources",[]))
                        )
                    ]
                    audits.append({
                        "caseId": row["caseId"], "entries": len(entries),
                        "candidates": sum(e.get("status")=="candidate" for e in entries),
                        "unexpectedActive": len(unexpected),
                        "quotedFormatActive": len(quoted_active),
                        "activeOriginViolations": len(bad_origins),
                    })
        known = [r["costUsd"] for r in rows if r["costUsd"] is not None]
        times = sorted(r["durationMs"] for r in rows if r["durationMs"] is not None)
        arms[arm] = {
            "status": dict(Counter(r["status"] for r in rows)),
            "metrics": {k: stat(v) for k, v in scores.items()},
            "phaseMetrics": {p: {k: stat(v) for k, v in m.items()} for p, m in by_phase.items()},
            "costUsd": sum(known),
            "unknownCosts": len(rows) - len(known),
            "medianDurationMs": statistics.median(times) if times else None,
            "maxDurationMs": max(times) if times else None,
            "confirmedModels": sorted({m["effective"] for m in models}),
            "modelConfirmations": len(models),
            "nativeSessions": len(sessions),
            "uniqueNativeSessions": len(set(sessions)),
            "nativeTokenCounters": {
                key: sum(
                    session.get(key) or 0
                    for row in rows
                    for session in row.get("observations", {}).get("accounting", {}).get("sessions", [])
                )
                for key in ["tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]
            },
            "reflections": reflections,
            "exploratory": {
                "invalidFirstJson": invalid_json,
                "scoredFirstAnswers": sum(bool(episodes[r["caseId"]]["checks"]) for r in rows),
                "invalidScoredFirstJson": [case for case in invalid_json if episodes[case]["checks"]],
                "firstOutputMentionsMemoryToolOrMarkup": pseudo_tools,
                "fenceOnlyRecoveries": fenced_recoveries,
                "correctionRepairs": correction_repairs,
                "memoryAudits": audits,
            },
        }
    return {
        "runId": run["id"],
        "createdAt": run["createdAt"],
        "codeSha256": run["plan"]["subject"]["codeSha256"],
        "datasetSha256": run["plan"]["dataset"]["sha256"],
        "runFileSha256": hashlib.sha256((directory / "run.json").read_bytes()).hexdigest(),
        "arms": arms,
    }


if __name__ == "__main__":
    results = {
        "schemaVersion": 1,
        "limitations": [
            "Synthetic longitudinal pilot, six profiles, one repetition; no independent blinded judge.",
            "Post-hoc JSON/tool-markup and memory snapshot diagnostics are exploratory, not preregistered scores.",
            "Oracle reader exact screen is not official LongMemEval semantic grading or memory retrieval.",
        ],
        "suites": {name: analyze(name) for name in ["longitudinal", "oracle-reader"]},
    }
    encoded = (json.dumps(results, ensure_ascii=False, indent=2) + "\n").encode()
    formatted = subprocess.run(
        [str(ROOT / "node_modules/.bin/biome"), "format", "--stdin-file-path=results.json"],
        input=encoded, capture_output=True, check=True,
    ).stdout
    DEST.write_bytes(formatted)
    # Compatible prediction file for a later, separately authorized upstream judge.
    oracle = json.loads((RUNS/"oracle-reader/run.json").read_text())
    predictions = []
    for row in oracle["results"]:
        text = next(
            json.loads(Path(p).read_text())["result"]["text"]
            for p in row["evidence"] if p.endswith("turn-0.json")
        )
        try:
            value = json.loads(text).get("answer", text)
            hypothesis = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        except (ValueError,AttributeError):
            hypothesis = text
        predictions.append({"question_id": row["caseId"], "hypothesis": hypothesis})
    (RUNS / "oracle-reader/hypotheses.jsonl").write_text(
        "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in predictions)
    )
