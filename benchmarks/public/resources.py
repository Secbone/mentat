"""Resource preflight used before downloads and model tasks; never deletes files."""
import json
import shutil
from pathlib import Path

GIB = 1024 ** 3
DEFAULT_RESERVE = 30 * GIB


def disk_budget(path, incoming_bytes=0, reserve_bytes=DEFAULT_RESERVE):
    if incoming_bytes < 0 or reserve_bytes < 0:
        raise ValueError("disk sizes must be non-negative")
    location = Path(path).resolve()
    while not location.exists():
        location = location.parent
    usage = shutil.disk_usage(location)
    after = usage.free - incoming_bytes
    return {
        "path": str(location), "totalBytes": usage.total,
        "freeBytes": usage.free, "incomingBytes": incoming_bytes,
        "reserveBytes": reserve_bytes, "remainingAfterBytes": after,
        "allowed": after >= reserve_bytes,
    }


def require_disk(path, incoming_bytes=0, reserve_bytes=DEFAULT_RESERVE):
    report = disk_budget(path, incoming_bytes, reserve_bytes)
    if not report["allowed"]:
        raise RuntimeError("insufficient disk budget; no cleanup performed: " + json.dumps(report))
    return report
