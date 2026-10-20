"""Read only sessions in one uniquely owned experiment directory, never credentials."""
import json
from pathlib import Path
import sqlite3
import sys

work = Path(sys.argv[1]).resolve()
database = Path.home() / ".local/share/opencode/opencode.db"
db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
rows = [dict(r) for r in db.execute("SELECT id,directory,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,version,time_created FROM session_v2 WHERE directory=? ORDER BY time_created", (str(work),))]
assert len(rows) == 3, "expected exactly three proposal sessions in the unique experiment cwd"
for row in rows:
    messages = []
    for message_type, raw in db.execute("SELECT type,data FROM session_message WHERE session_id=? ORDER BY seq", (row["id"],)):
        if message_type != "assistant":
            continue
        data = json.loads(raw)
        messages.append({"model": data.get("model"), "finish": data.get("finish"),
                         "contentTypes": [block.get("type") for block in data.get("content", []) if isinstance(block, dict)]})
    assert messages and all(m["model"] == {"id": "deepseek-v4.1-flash", "providerID": "opencode-go"} for m in messages), "actual assistant model mismatch"
    assert all(not any("tool" in str(t).lower() for t in m["contentTypes"]) for m in messages), "unexpected native tool block"
    row["assistantMessages"] = messages
print(json.dumps({"status": "complete", "sessions": rows, "costUsd": sum(r["cost"] for r in rows),
                  "model": "opencode-go/deepseek-v4.1-flash", "tools": 0,
                  "verification": "exact unique directory -> explicit session IDs -> native assistant message model fields; no ACP protocol capture in existing evolve CLI"}))
