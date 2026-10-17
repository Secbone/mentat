"""Fetch public metadata and byte sizes only; do not eagerly download datasets."""
import concurrent.futures
import datetime
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from resources import disk_budget

ROOT = Path(__file__).resolve().parents[2]
REPOS = {
    "longmemeval": "xiaowu0162/longmemeval-cleaned",
    "personamem-v2": "bowen-upenn/PersonaMem-v2",
    "memoryagentbench": "ai-hyz/MemoryAgentBench",
    "personamem-v3": "bowen-upenn/PersonaMem-v3",
    "rsi-exam": "RSI-Exam/RSI-Exam",
}


def fetch(item):
    name, repo = item
    url = "https://huggingface.co/api/datasets/" + repo + "?blobs=true"
    error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = json.load(response)
            directory = ROOT / ".mentat/benchmark-data/metadata"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / (name + ".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n")
            files = data.get("siblings", [])
            sizes = [f.get("size", f.get("lfs", {}).get("size")) for f in files]
            known = [s for s in sizes if isinstance(s, int)]
            return name, {
                "repository": repo, "revision": data.get("sha"),
                "gated": data.get("gated"), "metadataUrl": url,
                "fileCount": len(files), "knownSizeFiles": len(known),
                "repositoryFileBytesKnown": sum(known),
                "sizeMeaning": "File bytes only; excludes extraction, environments, model weights and duplicate caches.",
                "files": [{"path": f["rfilename"], "size": size} for f, size in zip(files, sizes)],
            }
        except (OSError, ValueError, urllib.error.HTTPError) as exception:
            error = str(exception)
            if attempt < 2:
                time.sleep(2 ** attempt)
    return name, {"repository":repo,"metadataUrl":url,"error":error}


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        result = dict(pool.map(fetch, REPOS.items()))
    for data in result.values():
        files = data.pop("files", [])
        data["largestFiles"] = sorted(files, key=lambda f: f.get("size") or 0, reverse=True)[:10]
    summary = {
        "schemaVersion": 1,
        "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "disk": disk_budget(ROOT), "datasets": result,
    }
    destination = ROOT / "benchmarks/public/dataset-metadata.json"
    destination.write_text(json.dumps(summary, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(result,indent=2))
