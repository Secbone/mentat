"""Controller-only namespaces: task labels must not become model-facing scope hints."""
import re
from pathlib import Path
import tempfile
import uuid

ISOLATION_PROTOCOL = "opaque-scopes-and-workspaces-v1"
SCOPE_PATTERN = r"ctx-[0-9a-f]{32}"


def new_subject_scopes(families):
    if len(set(families)) != len(families):
        raise ValueError("duplicate family namespace")
    return {family: f"ctx-{uuid.uuid4().hex}" for family in families}


def validate_scope_map(isolation, families):
    scopes = isolation.get("scopes", {})
    issues = []
    if isolation.get("protocol") != ISOLATION_PROTOCOL:
        issues.append("unknown subject isolation protocol")
    if set(scopes) != set(families):
        issues.append("subject scope map does not cover planned families exactly")
    if any(not isinstance(value, str) or not re.fullmatch(SCOPE_PATTERN, value) for value in scopes.values()):
        issues.append("non-opaque model-facing scope")
    if len(set(scopes.values())) != len(scopes):
        issues.append("different families share a subject scope")
    return issues


def validate_workspace(workspace, engine_cwds, experience):
    issues = []
    path = Path(workspace)
    if (not path.is_absolute() or path.parent.resolve() != Path(tempfile.gettempdir()).resolve()
            or not re.fullmatch(r"mentat-task-[A-Za-z0-9_-]{6,}", path.name)):
        issues.append("model workspace is not an opaque temporary directory")
    if not engine_cwds or set(engine_cwds) != {workspace}:
        issues.append("native engine workspace differs from isolated subject workspace")
    if not experience or experience[-1].get("cwd") != workspace:
        issues.append("native experience workspace differs from subject workspace")
    return issues
