"""Audit recorded ACP tools for a text-only run; not a packet-level network proof."""
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


def payload(directory, event):
    data = event.get("data", {})
    if isinstance(data, dict) and "artifact" in data:
        if not re.fullmatch(r"artifacts/[a-f0-9]{64}\.json", data["artifact"]):
            raise ValueError("invalid artifact path")
        raw = (directory / data["artifact"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == data["sha256"], "artifact digest mismatch"
        data = json.loads(raw)
    return data


def audit(root):
    counts = Counter({key: 0 for key in ["requests", "traces", "protocolFrames", "wireToolEvents", "normalizedToolEvents", "permissionDecisions"]})
    findings = []
    for request in sorted((root / "requests").iterdir()):
        if not request.is_dir():
            continue
        counts["requests"] += 1
        paths = list((request / "trace").rglob("events.jsonl"))
        if not paths:
            findings.append({"request": request.name, "issue": "missing trace"})
        for path in paths:
            counts["traces"] += 1
            manifest = json.loads((path.parent / "manifest.json").read_text())
            if manifest["status"] != "complete":
                findings.append({"request": request.name, "issue": "trace not complete", "status": manifest["status"]})
            for seq, line in enumerate(path.read_text().splitlines()):
                event = json.loads(line)
                assert event["seq"] == seq, "trace sequence gap"
                data = payload(path.parent, event)
                if event["type"] == "capture.gap":
                    findings.append({"request": request.name, "issue": "capture gap"})
                if event["type"] == "adapter.protocol":
                    wire = data.get("data", {})
                    update = wire.get("params", {}).get("update", {})
                    counts["protocolFrames"] += 1
                    if update.get("sessionUpdate") in ["tool_call", "tool_call_update"]:
                        counts["wireToolEvents"] += 1
                        findings.append({"request": request.name, "issue": "tool event in text-only run",
                                         "name": update.get("title", update.get("name")),
                                         "status": update.get("status")})
                if event["type"] == "agent.event":
                    kind = data.get("type", "")
                    if kind.startswith("tool."):
                        counts["normalizedToolEvents"] += 1
                    if kind == "permission.resolved":
                        counts["permissionDecisions"] += 1
                        if data.get("decision") != "deny":
                            findings.append({"request": request.name, "issue": "permission not denied"})
    return {"transport": str(root.resolve()), "counts": dict(counts), "findings": findings,
            "recordedToolPolicy": "passed" if not findings and counts["protocolFrames"] > 0 and not counts["normalizedToolEvents"] else "needs-review",
            "osNetworkIsolation": "not-verified",
            "scope": "Recorded ACP frames, normalized tool events, artifact integrity and trace completion. "
                     "No packet capture or OS filesystem/network sandbox proof; no proof of absence of model training contamination."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transport", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.transport)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    if report["recordedToolPolicy"] != "passed":
        raise SystemExit(2)
