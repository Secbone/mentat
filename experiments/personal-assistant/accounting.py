"""Read only this experiment's session IDs from OpenCode's local accounting tables."""
import argparse
import json
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directories", nargs="+")
parser.add_argument("--db", default=str(Path.home() / ".local/share/opencode/opencode.db"))
args = parser.parse_args()
db = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
fields = ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]

for directory in args.directories:
    root = Path(directory)
    records = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines()]
    accounting = []
    for record in records:
        sessions = []
        for sid in sorted({item["wireSessionId"] for item in record["nativeModels"]}):
            found = None
            for table in ["session_v2", "session"]:
                if table not in tables:
                    continue
                found = db.execute(f"select {','.join(fields)},version from {table} where id=?", (sid,)).fetchone()
                if found:
                    break
            if not found:
                raise RuntimeError(f"Accounting missing for experiment session {sid}")
            sessions.append({"id": sid, "engineVersion": found[-1], **dict(zip(fields, found[:-1]))})
        totals = {key: sum(session[key] for session in sessions) for key in fields}
        acp_totals = {}
        for item in record["nativeAcpUsage"]:
            if item.get("cost", {}).get("currency") == "USD":
                acp_totals[item["wireSessionId"]] = item["cost"]["amount"]
        acp_cost = sum(acp_totals.values())
        models = {
            config["currentValue"]
            for metadata in record["nativeModels"]
            for config in metadata.get("modelConfig", [])
            if config.get("id") == "model"
        }
        if models != {"opencode-go/deepseek-v4.1-flash"}:
            raise RuntimeError(f"Unexpected model for {record['id']}: {models}")
        entry = {"id": record["id"], "scenario": record["scenario"], "arm": record["arm"],
                 "sessions": sessions, "models": sorted(models), **totals,
                 "acpCostUsd": acp_cost, "costDifferenceUsd": totals["cost"] - acp_cost,
                 "wallTimeMs": sum((record.get(key) or {}).get("wallTimeMs", 0) for key in ["first", "revision", "reflection"])}
        entry["acpCostMatchesSessionTotal"] = abs(entry["costDifferenceUsd"]) <= 0.000001
        # ACP can omit costs added after the visible settled event (e.g. an idle continuation).
        # Preserve the discrepancy and use the native session accounting as authority.
        accounting.append(entry)
    (root / "accounting.json").write_text(json.dumps(accounting, ensure_ascii=False, indent=2) + "\n")
    print(root.name, {key: sum(item[key] for item in accounting) for key in fields})
