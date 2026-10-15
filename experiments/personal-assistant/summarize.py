"""Summarize the explicitly selected pilot cohorts; excluded runs remain intact."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2] / ".mentat/experiments/personal-assistant"
selected = [
    ("product-A-v3", {"A"}, "main"),
    ("product-BC-v3", {"B"}, "main"),
    ("engineer-ABC-v3", {"A", "B"}, "main"),
    ("household-ABC-v3", {"A", "B"}, "main"),
    ("product-C-v4", {"C"}, "main"),
    ("engineer-C-v4", {"C"}, "main"),
    ("household-C-v4", {"C"}, "main"),
    ("cold-MCP-control-v4", {"C0"}, "cold-control"),
    ("product-challenge-v5", {"C", "C0"}, "challenge"),
    ("household-challenge-v5", {"C", "C0"}, "challenge"),
    ("household-injection-diagnostic", {"C"}, "injection-diagnostic"),
]
manifest = []
totals = {}
reflections = []
for name, arms, scope in selected:
    base = root / name
    records = {item["id"]: item for item in map(json.loads, (base / "results.jsonl").read_text().splitlines())}
    for accounting in json.loads((base / "accounting.json").read_text()):
        if accounting["arm"] not in arms:
            continue
        record = records[accounting["id"]]
        entry = {
            "id": accounting["id"], "scope": scope, "arm": accounting["arm"],
            "scenario": accounting["scenario"], "episode": record["episode"],
            "resultPath": str(base / (accounting["id"] + ".json")),
            "accountingPath": str(base / "accounting.json"),
            "costUsd": accounting["cost"],
            "engineVersions": sorted({session["engineVersion"] for session in accounting["sessions"]}),
            "hostTurns": sum(bool(record.get(key)) for key in ["first", "revision", "reflection"]),
        }
        manifest.append(entry)
        key = (scope, accounting["arm"])
        group = totals.setdefault(key, {"tasks": 0, "hostTurns": 0, "costUsd": 0,
                                       "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0,
                                       "wallTimeMs": 0, "protocolLeaks": 0})
        group["tasks"] += 1
        group["hostTurns"] += entry["hostTurns"]
        group["costUsd"] += accounting["cost"]
        for target, source in [("input", "tokens_input"), ("output", "tokens_output"),
                               ("reasoning", "tokens_reasoning"), ("cacheRead", "tokens_cache_read"),
                               ("wallTimeMs", "wallTimeMs")]:
            group[target] += accounting[source]
        group["protocolLeaks"] += "DSML" in record["first"]["text"]
        if record.get("reflection"):
            sid = record["nativeModels"][-1]["wireSessionId"]
            session = next(item for item in accounting["sessions"] if item["id"] == sid)
            reflections.append({"id": record["id"], "text": record["reflection"]["text"],
                                "costUsd": session["cost"], "wallTimeMs": record["reflection"]["wallTimeMs"]})
assert len(manifest) == 113
assert len(reflections) == 18
assert all(re.fullmatch(r"(?:\[\])+", re.sub(r"```(?:json)?|\s", "", item["text"]))
           for item in reflections), "Reflection output changed; do not assume zero extracted facts"
report = {
    "model": "opencode-go/deepseek-v4.1-flash",
    "validRecords": manifest,
    "groups": [{"scope": scope, "arm": arm, **group} for (scope, arm), group in totals.items()],
    "reflection": {"calls": len(reflections), "addedEntries": 0,
                   "costUsd": sum(item["costUsd"] for item in reflections),
                   "wallTimeMs": sum(item["wallTimeMs"] for item in reflections),
                   "observations": reflections},
    "limitations": ["Single repetition per condition", "No independent human raters",
                    "No corrective-turn measurement on held-out tasks",
                    "C0 controls tool availability; A/B tool gateway differs from C",
                    "Runtime directory names were not blinded", "No code evolution tested"],
    "excluded": ["preflight-product-A: engine 1.18.30 differs from formal runs",
                 "C rows in product-BC-v3 and *-ABC-v3: initial permissions blocked MCP gateway",
                 "startup-only directories: no model task output",
                 "challenge-v4: availability and business opening hours ambiguous"],
}
(root / "pilot-analysis.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"tasks": len(manifest), "hostTurns": sum(item["hostTurns"] for item in manifest),
                  "costUsd": sum(item["costUsd"] for item in manifest),
                  "groups": report["groups"]}, ensure_ascii=False, indent=2))
