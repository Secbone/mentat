"""Read only explicitly supplied session ids; no credential reads or database mutations."""
import json
import sqlite3
import sys
from pathlib import Path

ids = sorted(set(json.load(sys.stdin)))
path = Path.home() / ".local/share/opencode/opencode.db"
if not ids or not path.exists():
    print(json.dumps({"status": "unavailable", "sessions": [], "missing": ids}))
    sys.exit(0)
db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
fields = ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "model", "version"]
rows, missing = [], []
for sid in ids:
    found = None
    for table in ["session_v2", "session"]:
        if table not in tables:
            continue
        columns = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        if not all(f in columns for f in fields):
            continue
        found = db.execute(f"SELECT {','.join(fields)} FROM {table} WHERE id=?", (sid,)).fetchone()
        if found:
            break
    if found is None:
        missing.append(sid)
    else:
        rows.append({"id": sid, **dict(zip(fields, found))})
print(json.dumps({"status": "complete" if not missing else "partial", "sessions": rows, "missing": missing}))
