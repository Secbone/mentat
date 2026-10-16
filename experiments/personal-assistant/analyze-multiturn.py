"""Deterministic screening, native accounting refresh, and evidence index. No model calls."""
import argparse
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory")
parser.add_argument("--out")
args = parser.parse_args()
root = Path(args.directory).resolve()
rows = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines() if line.strip()]
manifest = json.loads((root / "manifest.json").read_text())

def safe_ratio(n, d):
    return {"passed": n, "total": d, "rate": n / d if d else None}

by_arm = {}
for arm in ["persistent", "reset"]:
    group = [row for row in rows if row["arm"] == arm]
    turns = [turn for row in group for turn in row["turns"]]
    checks = [check for turn in turns for check in turn["checks"]]
    phases = {}
    operation_rows = [row["reflection"] for row in group if isinstance(row["reflection"], dict) and "applicationStatus" in row["reflection"]]
    for phase in ["learn", "exception", "transfer"]:
        phase_turns = [turn for row in group if row["task"] == phase for turn in row["turns"]]
        phase_checks = [check for turn in phase_turns for check in turn["checks"]]
        phases[phase] = safe_ratio(sum(check["passed"] for check in phase_checks), len(phase_checks))
    by_arm[arm] = {
        "tasks": len(group), "turns": len(turns),
        "execution": safe_ratio(sum(turn["reason"] == "done" for turn in turns), len(turns)),
        "lexicalScreening": safe_ratio(sum(check["passed"] for check in checks), len(checks)),
        "phases": phases,
        "turnWallTimeMs": sum(turn["durationMs"] for turn in turns),
        "reflectionValid": sum(isinstance(row["reflection"], dict) and row["reflection"].get("status") == "ok" for row in group),
        "reflectionCalls": sum(bool(row["reflection"]) for row in group),
        "reflectionOperations": {"observed": len(operation_rows), **{key: sum(item.get(key, 0) for item in operation_rows) for key in ["added", "merged", "skipped", "rejected"]}},
        "reflectionApplicationFailures": sum(item["applicationStatus"] in ["partial", "rejected", "not-applied"] for item in operation_rows),
        "captureGaps": sum((row.get("trajectory") or {}).get("gaps", 0) for row in group),
        "invariantViolations": [item for row in group for item in (row.get("trajectory") or {}).get("violations", [])],
    }

transfers = []
failures = []
memory = []
for row in rows:
    for turn in row["turns"]:
        failed = [check["name"] for check in turn["checks"] if not check["passed"]]
        if failed:
            failures.append({"id": row["id"], "turn": turn["index"] + 1, "failedChecks": failed, "answer": turn["answer"], "traceId": row["traceId"]})
    if row["task"] == "transfer" and row["turns"]:
        first = row["turns"][0]
        transfers.append({"scenario": row["scenario"], "arm": row["arm"], "checks": first["checks"], "answer": first["answer"], "activeMemoriesBefore": [entry for entry in row["memoryBefore"] if entry.get("status", "active") == "active"], "traceId": row["traceId"]})
    if row["arm"] == "persistent":
        memory.append({"id": row["id"], "beforeCount": len(row["memoryBefore"]), "afterCount": len(row["memoryAfter"]),
                       "active": [entry for entry in row["memoryAfter"] if entry.get("status", "active") == "active"],
                       "candidates": [entry for entry in row["memoryAfter"] if entry.get("status") == "candidate"],
                       "unsafeActivation": [entry for entry in row["memoryAfter"] if entry.get("status", "active") == "active" and (entry.get("basis") != "user" or entry.get("speaker") != "user")]})

# Query only IDs belonging to the experiment; preserve main/reflection separation.
sessions = {}
for row in rows:
    phase = "main"
    log = Path(row["logDir"])
    for line in (log / "events.jsonl").read_text().splitlines():
        event = json.loads(line)
        if event["type"] == "reflection.start":
            phase = "reflection"
        data = event.get("data", {})
        if isinstance(data, dict) and "artifact" in data:
            data = json.loads((log / data["artifact"]).read_text())
        if event["type"] == "adapter.protocol":
            sid = (data.get("data", {}).get("result") or {}).get("sessionId")
            if sid:
                sessions[sid] = {"id": sid, "case": row["id"], "arm": row["arm"], "phase": phase}

# Compare normalized tool/permission observations with captured wire facts.
def content_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(content_text(item) for item in value)
    if isinstance(value, dict):
        if value.get("type") == "text":
            return str(value.get("text", ""))
        return content_text(value.get("content", ""))
    return ""

observation_gaps = []
for row in rows:
    log = Path(row["logDir"])
    starts, results, raw_inputs, raw_outputs = {}, {}, {}, {}
    permission_wire, permission_normalized = 0, 0
    for line in (log / "events.jsonl").read_text().splitlines():
        event = json.loads(line)
        data = event.get("data", {})
        if isinstance(data, dict) and "artifact" in data:
            data = json.loads((log / data["artifact"]).read_text())
        if event["type"] == "agent.event":
            if data.get("type") == "tool.start":
                starts[data["id"]] = data.get("input")
            if data.get("type") == "tool.update" and "input" in data:
                starts[data["id"]] = data["input"]
            if data.get("type") == "tool.result":
                results[data["id"]] = data.get("output", "")
            if data.get("type") == "permission.request":
                permission_normalized += 1
        if event["type"] == "adapter.protocol":
            wire = data.get("data", {})
            if wire.get("method") == "session/request_permission":
                permission_wire += 1
            update = wire.get("params", {}).get("update", {})
            tid = update.get("toolCallId")
            if tid:
                if update.get("rawInput"):
                    raw_inputs[tid] = update["rawInput"]
                text = content_text(update.get("content"))
                if text:
                    raw_outputs[tid] = text
    lost_inputs = [tid for tid, value in raw_inputs.items() if value and tid in starts and starts[tid] in [{}, None]]
    lost_outputs = [tid for tid, text in raw_outputs.items() if text and tid in results and not results[tid]]
    observation_gaps.append({"id": row["id"], "permissionWire": permission_wire, "permissionNormalized": permission_normalized,
                             "toolInputsMissing": lost_inputs, "toolOutputsMissing": lost_outputs, "traceId": row["traceId"]})

native_path = Path.home() / ".local/share/opencode/opencode.db"
accounting = []
if native_path.exists():
    db = sqlite3.connect(native_path.resolve().as_uri() + "?mode=ro", uri=True)
    tables = {entry[0] for entry in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    fields = ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "model", "version"]
    for sid, info in sessions.items():
        found = None
        for table in ["session_v2", "session"]:
            if table in tables:
                found = db.execute(f"SELECT {','.join(fields)} FROM {table} WHERE id=?", (sid,)).fetchone()
                if found:
                    break
        accounting.append({**info, "status": "complete" if found else "missing", **(dict(zip(fields, found)) if found else {})})

costs = defaultdict(float)
for record in accounting:
    costs[f"{record['arm']}/{record['phase']}"] += record.get("cost", 0) or 0

analysis = {
    "datasetVersion": manifest["datasetVersion"], "datasetSha256": manifest["datasetSha256"],
    "strategy": {key: manifest.get(key) for key in ["inputSchemaVersion", "reflectionSchemaVersion", "promptVersion", "runnerSha256"]},
    "model": manifest["model"], "revision": manifest["revision"], "tasks": len(rows),
    "byArm": by_arm, "firstTurnTransfers": transfers, "screeningFailures": failures,
    "memoryAudit": memory, "observationGaps": observation_gaps, "accounting": accounting, "costUsdByArmAndPhase": dict(costs),
    "modelsObserved": sorted({model["effective"] for row in rows for model in row["nativeModels"] if model.get("effective")}),
    "limits": manifest["design"]["limitations"],
}
out = Path(args.out) if args.out else root / "analysis.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n")
review = []
for row in rows:
    review.append(f"\n## {row['id']} trace={row['traceId']}\n")
    for turn in row["turns"]:
        review.append(f"\n### Turn {turn['index'] + 1}\n用户：{turn['text']}\n\n答复：{turn['answer']}\n\n筛查：{json.dumps(turn['checks'], ensure_ascii=False)}\n")
    review.append("\n记忆：" + json.dumps(row["memoryAfter"], ensure_ascii=False) + "\n")
(root / "review.md").write_text("".join(review))
print(json.dumps({"tasks": len(rows), "byArm": by_arm, "screeningFailures": len(failures), "costUsdByArmAndPhase": dict(costs), "analysis": str(out)}, ensure_ascii=False))
