"""Independent source check for native recall; never scores model assertions."""
from datetime import datetime, timezone
import json
import re


def identity(records):
    # ExperienceStore may attach observer feedback on read. It is not recall input.
    return [{key: row.get(key) for key in ("id", "ts", "scope", "cwd", "imported", "outcome", "messages")} for row in records]


def read_records(directory):
    return [json.loads(line) for path in sorted(directory.glob("*.jsonl"))
            for line in path.read_text().splitlines() if line.strip()]


def check_selection(records, selection, scope, max_chars):
    errors = []
    by_id = {row["id"]: row for row in records}
    if len(by_id) != len(records):
        errors.append("duplicate native experience identity")
    text = selection.get("text", "")
    # JS measures UTF-16 code units, not Python codepoints.
    if len(text.encode("utf-16-le")) // 2 > max_chars:
        errors.append("native recall exceeded budget")
    pieces = []
    for line in text.splitlines():
        try:
            pieces.append(json.loads(line))
        except (ValueError, TypeError):
            errors.append("invalid recall JSONL")
    pointers = [piece.get("pointer") for piece in pieces]
    if pointers != selection.get("selectedIds") or len(set(pointers)) != len(pointers):
        errors.append("native recall pointer list mismatch")
    if selection.get("sourceKind") != "native-interaction" or selection.get("strategy") != "bm25-atomic-messages-v1":
        errors.append("unexpected native recall strategy")
    for piece in pieces:
        match = re.fullmatch(r"(.+)#msg(\d+):0", str(piece.get("pointer")))
        record = by_id.get(match[1]) if match else None
        if not record or record.get("imported") or record.get("scope") != scope:
            errors.append("native recall outside original scoped source")
            continue
        messages = record.get("messages", [])
        index = int(match[2])
        if index >= len(messages):
            errors.append("native recall missing original message")
            continue
        message = messages[index]
        source_scope = "unspecified"
        content = message.get("text", "")
        if message["role"] == "user":
            fragments = [f for f in message.get("fragments", []) if f["origin"] == "user"]
            content = "\n".join(f["text"] for f in fragments)
            if any(f.get("memoryScope") == "task" for f in fragments):
                source_scope = "task"
            elif fragments and all(f.get("memoryScope") == "reusable" for f in fragments):
                source_scope = "reusable"
        elif message["role"] != "assistant":
            content = ""
        date = datetime.fromtimestamp(record["ts"] / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expected = {"source": "native-interaction", "session": record["id"], "date": date,
                    "role": message["role"], "sourceMemoryScope": source_scope,
                    "engineOutcome": record["outcome"], "scope": scope,
                    "pointer": piece["pointer"], "content": content}
        if not content or piece != expected:
            errors.append("native recall differs from whole original attributed message")
    return errors
