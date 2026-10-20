"""PAST-only projections of native evidence. Never invent legacy memory calls/artifacts."""
import hashlib
import json

READS = {"notes_list", "notes_get", "helpdesk_list_tickets", "helpdesk_get_ticket", "kb_search", "kb_get_article"}
WRITES = {"notes_share", "notes_update", "helpdesk_update_ticket"}
KINDS = ["memory", "native-history", "imported-history", "procedure", "procedure-catalog"]


def action_effects(names):
    return {f"environment_{name}": "read" if name in READS else "write" if name in WRITES else "unknown" for name in names}


def memory_call_counts(calls):
    successful = [call for call in calls if call.get("status") == "completed"]
    names = {"direct_memory_memory_search", "direct_memory_memory_add"}
    return {"memory_calls": sum(call["name"] in names for call in successful),
            "memory_read_count": sum(call["name"] == "direct_memory_memory_search" for call in successful),
            "memory_write_count": sum(call["name"] == "direct_memory_memory_add" for call in successful)}


def project_recall(report, turn_id):
    if not report or report.get("schemaVersion") != 1:
        return {"schemaVersion": 1, "status": "unavailable", "reason": "native recall evidence unavailable"}
    evidence = [item for item in report["evidence"] if item["turnId"] == turn_id]
    counts = {}
    for kind in KINDS:
        subset = [item for item in evidence if item["kind"] == kind]
        delivered = [item for item in subset if item["method"] == "context" and item["outcome"] == "hit" and item["delivery"] == "captured-request" and not item["issues"]]
        counts[kind] = {"attempts": len(subset), "capturedContextInjections": len(delivered),
                        "successfulToolReads": sum(item["method"] == "tool" and item["outcome"] in {"hit", "empty", "unparsed"} for item in subset),
                        "hits": sum(item["outcome"] == "hit" for item in subset),
                        "empty": sum(item["outcome"] == "empty" for item in subset),
                        "failed": sum(item["outcome"] == "failed" for item in subset),
                        "unverified": sum(item["outcome"] in {"unparsed", "incomplete"} for item in subset),
                        "evidenceBeforeWrite": sum(item["outcome"] == "hit" and item["beforeFirstWrite"] is True and not item["issues"] for item in subset)}
    return {"schemaVersion": 1, "status": report["status"], "turnId": turn_id, "byKind": counts,
            "legacyScoreOverride": False,
            "limits": ["Historical context is not relabelled as memory_search or confirmed active memory.",
                       "Catalog metadata is separate from complete procedure reads.",
                       "Availability is not proof of semantic correctness, model attention or causal benefit."]}


def validate_report(report, events, turn_id):
    """Independent check of report identities, hashes, raw request/receipts and action order."""
    errors = []
    if not report or report.get("schemaVersion") != 1:
        return ["missing native recall attribution report"]
    if report.get("issues"):
        errors.append("native recall report contains integrity issues")
    if report.get("status") == "unavailable":
        errors.append("native recall evidence is unavailable")
    local = [e for e in events if e.get("turnId") == turn_id]
    by_seq = {e["seq"]: e for e in events}
    policy = next((e["data"] for e in events if e["type"] == "recall.policy"), {})
    if policy.get("schemaVersion") != 1:
        errors.append("missing native recall tool policy")
    reads, effects = policy.get("reads", {}), policy.get("actionEffects", {})
    selections = {e["data"]["recallId"]: e for e in local if e["type"] in {"recall.selection", "recall.error", "recall.start"}}
    calls, results = {}, {}
    for event in local:
        data = event.get("data", {})
        if event["type"] != "agent.event":
            continue
        if data.get("type") == "tool.start":
            calls[data["id"]] = event
        if data.get("type") == "tool.update" and data.get("name") and data["id"] in calls:
            calls[data["id"]] = {**calls[data["id"]], "data": {**calls[data["id"]]["data"], "name": data["name"]}}
        if data.get("type") == "tool.result":
            results[data["id"]] = event
    expected_ids = set(selections) | {key for key, call in calls.items() if call["data"]["name"] in reads}
    evidence = [item for item in report.get("evidence", []) if item["turnId"] == turn_id]
    if len(evidence) != len(expected_ids) or {item["recallId"] for item in evidence} != expected_ids:
        errors.append("recall report identities differ from actual attempts")
    start = next((e for e in local if e["type"] == "turn.start"), None)
    assembly = next((e for e in local if e["type"] == "prompt.assembled"), None)
    connection = next((e["data"].get("spanId") for e in events if e["type"] == "session.create.end" and start and e["data"].get("sessionId") == start.get("sessionId")), None)
    writes = [call["seq"] for call in calls.values() if effects.get(call["data"]["name"]) == "write"]
    first_write = min(writes) if writes else None
    unknown = [call["seq"] for call in calls.values() if call["data"]["name"] not in reads and call["data"]["name"] not in policy.get("internalTools", []) and effects.get(call["data"]["name"]) not in {"read", "write"}]
    digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
    for item in evidence:
        available = item.get("availableSequence")
        if item["firstKnownWriteSequence"] != first_write:
            errors.append("reported first business write differs from declared native action")
        if item["beforeFirstWrite"] is True and (available is None or first_write is None or available >= first_write or any(seq <= available for seq in unknown)):
            errors.append("claimed pre-write recall lacks native ordering evidence")
        if item["method"] == "context":
            selection = selections.get(item["recallId"])
            if not selection or item["selectionSequence"] != selection["seq"] or item["kind"] != selection["data"]["kind"]:
                errors.append("context recall differs from native selection")
                continue
            data = selection["data"]
            if selection["type"] == "recall.selection" and item["sources"] != data["sources"]:
                errors.append("reported recall source metadata changed")
            if item["delivery"] != "captured-request":
                continue
            frame = by_seq.get(available, {})
            wire = frame.get("data", {})
            if not start or not assembly or wire.get("connectionId") != connection or wire.get("direction") != "out" or wire.get("data", {}).get("method") != "session/prompt" or frame.get("seq", -1) <= start["seq"]:
                errors.append("reported context delivery has no matching native request")
                continue
            section = next((part for part in assembly["data"]["contexts"] if part["name"] == data["contextName"]), None)
            if not section or digest(section["text"]) != data["contentSha256"]:
                errors.append("selected recall content differs from assembly")
            actual = start["data"]["input"]
            raw_context = actual.get("context", "")
            try:
                parts = [json.loads(line) for line in raw_context.splitlines()]
            except ValueError:
                parts = []
            if parts and all(isinstance(part, dict) and "name" in part and "text" in part for part in parts):
                matched = [part["text"] for part in parts if part["name"] == data["contextName"]]
                actual_section = matched[0] if len(matched) == 1 else None
            else:
                actual_section = raw_context if data["contextName"] == "memory" else None
            if actual_section is None or digest(actual_section) != data["contentSha256"]:
                errors.append("reported injected source differs from actual turn input")
            reference = json.dumps({"reference": actual.get("context", "")}, ensure_ascii=False, separators=(",", ":"))
            suffix = "Current user request:\n\n" + actual["text"]
            if not any(block.get("type") == "text" and reference in block.get("text", "") and block["text"].endswith(suffix) for block in wire["data"]["params"].get("prompt", [])):
                errors.append("reported recall does not match actual serialized model input")
        elif item["method"] == "tool":
            call = calls.get(item["recallId"])
            result = results.get(item["recallId"])
            if not call or item["kind"] != reads.get(call["data"]["name"]) or item["selectionSequence"] != call["seq"]:
                errors.append("reported tool read differs from native call")
            if item["outcome"] == "hit" and (not result or result["data"].get("isError") is not False or available != result["seq"] or available <= item["selectionSequence"]):
                errors.append("reported read hit lacks a successful completed result")
            if result and result["data"].get("isError") is True and item["outcome"] != "failed":
                errors.append("failed tool read was counted as successful")
            if item["outcome"] == "hit" and result:
                try:
                    payload = json.loads(result["data"]["output"])
                    payload = payload if isinstance(payload, list) else [payload]
                    id_field = "name" if item["kind"] in {"procedure", "procedure-catalog"} else "id"
                    if [part[id_field] for part in payload] != [part["id"] for part in item["sources"]]:
                        errors.append("tool recall source identities differ from actual result")
                    for part, ref in zip(payload, item["sources"]):
                        if "state" in ref and ref["state"] != part.get("status"):
                            errors.append("tool recall promoted or changed source state")
                    if result["data"].get("outputCoverage") in {"partial", "unsupported"}:
                        errors.append("partial tool output counted as a verified hit")
                except (ValueError, KeyError, TypeError):
                    errors.append("tool recall hit has no parseable native result")
    return errors
