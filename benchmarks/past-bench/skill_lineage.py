"""Validate procedural persistence from actual native writes and completed reads."""
from copy import deepcopy


def validate_transition(before, after, calls, scope):
    issues = []
    expected = {s["name"]: deepcopy(s) for s in before}
    if len(expected) != len(before) or len({s["name"] for s in after}) != len(after):
        issues.append("duplicate skill identity")
    for call in calls:
        if call["name"] != "procedures_skill_save" or call["status"] != "completed":
            continue
        draft = call.get("input", {})
        name = draft.get("name")
        previous = expected.get(name)
        version = previous.get("version", 0) if previous else 0
        if draft.get("expectedVersion") != version:
            issues.append(f"successful write has incompatible prior version: {name}")
        expected[name] = {k: draft.get(k) for k in ["name", "description", "applicability", "content", "evidence"]}
        expected[name].update(version=version + 1, scope=scope, origin="agent-procedure")
        if previous and "createdAt" in previous:
            expected[name]["createdAt"] = previous["createdAt"]
    actual = {s["name"]: s for s in after}
    if actual.keys() != expected.keys():
        issues.append("skill identity added/deleted without an actual successful write")
    for name, skill in actual.items():
        if skill.get("scope") != scope or skill.get("origin") != "agent-procedure":
            issues.append(f"unexpected skill scope/origin: {name}")
        if name in expected and any(skill.get(k) != value for k, value in expected[name].items()):
            issues.append(f"skill state not supported by native writes: {name}")
    return issues


def inherited_reads(before, calls, events):
    """A read must finish before the first business write starts, not merely start first."""
    inherited = {s["name"] for s in before}
    starts, results = {}, {}
    first_write = None
    writes = {"environment_helpdesk_update_ticket", "environment_notes_share", "environment_notes_update"}
    for event in events:
        data = event["data"]
        if data.get("type") == "tool.start":
            starts[data["id"]] = event["seq"]
            if data.get("name") in writes:
                first_write = event["seq"] if first_write is None else min(first_write, event["seq"])
        elif data.get("type") == "tool.result" and data.get("isError") is False:
            results[data["id"]] = event["seq"]
    reads = []
    for call in calls:
        if call["name"] != "procedures_skill_view" or call["status"] != "completed" or call.get("input", {}).get("name") not in inherited:
            continue
        call_id = call["id"]
        if call_id not in starts or call_id not in results or starts[call_id] >= results[call_id]:
            continue
        reads.append({"name": call["input"]["name"], "id": call_id, "resultSequence": results[call_id],
                      "firstBusinessWriteSequence": first_write, "completedBeforeBusinessWrite": first_write is not None and results[call_id] < first_write})
    return reads
