"""Combine disjoint completed/blocked pilot batches without dropping planned cases.

Duplicate case ids are rejected: this is not a best-of-attempt selector.
"""
import argparse
import hashlib
import json
from pathlib import Path


def merge(inputs, output):
    manifests, cases, identities, tasks = [], [], set(), {}
    baseline = None
    for source in inputs:
        manifest = json.loads((source / "manifest.json").read_text())
        results = json.loads((source / "results.json").read_text())
        if results["status"] not in ("completed", "incomplete") or (source / "invalidation.json").exists():
            raise ValueError("cannot merge running or invalidated attempts")
        identity = [manifest[k] for k in ("upstreamRevision", "subjectRevision", "model", "memory", "timeoutMs", "maxSteps")]
        identity.append(manifest.get("runtime"))
        if baseline is None:
            baseline = identity
            merged_manifest = dict(manifest)
        if identity != baseline:
            raise ValueError("incompatible pilot identity, runtime or budget")
        if {r["id"] for r in results["cases"]} != set(manifest["ids"]):
            raise ValueError("pilot result coverage does not match its planned ids")
        for row in results["cases"]:
            if row["id"] in identities:
                raise ValueError("duplicate case; do not select the best attempt")
            identities.add(row["id"])
            cases.append(row)
            tasks[row["id"]] = manifest["tasks"][row["id"]]
        manifests.append({"source": str(source.resolve()), "manifestSha256": hashlib.sha256((source / "manifest.json").read_bytes()).hexdigest(), "resultsSha256": hashlib.sha256((source / "results.json").read_bytes()).hexdigest()})
    if baseline is None:
        raise ValueError("at least one pilot is required")
    merged_manifest.update(ids=[row["id"] for row in cases], tasks=tasks, sourceBatches=manifests)
    complete = [row for row in cases if row["status"] == "completed"]
    results = {"status": "completed" if len(complete) == len(cases) else "incomplete", "planned": len(cases), "scored": len(complete), "resolved": sum(r["reward"] for r in complete), "resolvedRate": sum(r["reward"] for r in complete) / len(cases) if len(complete) == len(cases) else None, "cases": cases}
    output.mkdir(parents=True)
    (output / "manifest.json").write_text(json.dumps(merged_manifest, indent=2) + "\n")
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    merge(args.inputs, args.out)
