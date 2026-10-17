"""Read-only capacity snapshot. Unknown environment sizes never imply a fit."""
import argparse
import datetime
import json
import subprocess
import tomllib
from pathlib import Path

from resources import GIB, disk_budget

ROOT = Path(__file__).resolve().parents[2]


def allocated_bytes(path):
    if not path.exists():
        return 0
    return int(subprocess.check_output(["du", "-sk", str(path)], text=True).split()[0]) * 1024


def snapshot(incoming_bytes=0, docker_incoming_bytes=None):
    metadata = json.loads((ROOT / "benchmarks/public/dataset-metadata.json").read_text())
    datasets = metadata["datasets"]
    rsi = []
    for path in sorted((ROOT / ".mentat/benchmark-data/rsi-exam").glob("*/task.toml")):
        task = tomllib.loads(path.read_text())
        agent = task.get("environment", {})
        verifier = task.get("verifier", {}).get("environment", {})
        rsi.append({
            "task": path.parent.name,
            "agentStorageMB": agent.get("storage_mb"),
            "verifierStorageMB": verifier.get("storage_mb"),
            "agentGPUs": agent.get("gpus"), "verifierGPUs": verifier.get("gpus"),
            "meaning": "Declared task allocation; not measured image/build/cache size.",
        })
    docker = {"status": "unmeasured", "plannedIncomingBytes": docker_incoming_bytes}
    try:
        result = subprocess.run(
            ["colima", "ssh", "--", "df", "-Pk", "/var/lib/docker"],
            capture_output=True, text=True, timeout=20, check=True,
        )
        fields = result.stdout.strip().splitlines()[-1].split()
        free = int(fields[3]) * 1024
        docker.update(status="measured", freeBytes=free, totalBytes=int(fields[1]) * 1024,
                      reserveBytes=5 * GIB,
                      plannedBatchFits=None if docker_incoming_bytes is None
                      else free - docker_incoming_bytes >= 5 * GIB)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        docker["error"] = str(error)
    return {
        "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": disk_budget(ROOT, incoming_bytes), "docker": docker,
        "allocatedLocalBytes": {name: allocated_bytes(ROOT / ".mentat" / name) for name in
                                ("benchmark-data", "upstream", "public-evaluations", "venvs", "tools")},
        "knownDatasetRepositoryBytes": sum(d["repositoryFileBytesKnown"] for d in datasets.values()),
        "knownDatasetRepositories": list(datasets),
        "unmeasuredEnvironmentSuites": ["past-bench", "toolsandbox", "tau-bench", "agentdojo",
                                        "memoryarena", "skillsbench", "rsi-exam"],
        "rsiDeclaredResources": rsi,
        "allElevenEnvironmentsFit": None,
        "limitations": "Repository sizes exclude extraction, indexes, weights, environments, build cache and logs. "
                        "Do not sum host and Docker free space. Check actual image/build needs per batch. "
                        "This command never deletes or resizes resources.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--incoming-gib", type=float, default=0)
    parser.add_argument("--docker-incoming-gib", type=float)
    args = parser.parse_args()
    if args.incoming_gib < 0 or (args.docker_incoming_gib is not None and args.docker_incoming_gib < 0):
        parser.error("incoming sizes must be non-negative")
    report = snapshot(int(args.incoming_gib * GIB),
                      None if args.docker_incoming_gib is None else int(args.docker_incoming_gib * GIB))
    print(json.dumps(report, indent=2))
    if not report["host"]["allowed"] or report["docker"].get("plannedBatchFits") is False:
        raise SystemExit(2)
    if args.docker_incoming_gib is not None and report["docker"]["status"] != "measured":
        raise SystemExit(2)
