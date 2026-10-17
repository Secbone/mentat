"""Pinned, streaming public-asset downloader with size/digest and disk checks."""
import argparse
import concurrent.futures
import hashlib
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from resources import require_disk

ROOT = Path(__file__).resolve().parents[2]


def download(dataset, filename):
    meta = json.loads((ROOT / ".mentat/benchmark-data/metadata" / f"{dataset}.json").read_text())
    entry = next(f for f in meta["siblings"] if f["rfilename"] == filename)
    expected = entry.get("size", entry.get("lfs", {}).get("size"))
    if not isinstance(expected, int):
        raise ValueError("unknown upstream asset size")
    path = ROOT / ".mentat/benchmark-data" / dataset / filename
    if ".." in Path(filename).parts or Path(filename).is_absolute():
        raise ValueError("invalid asset path")
    repo = meta.get("id") or meta.get("_id")
    if not isinstance(repo, str) or "/" not in repo:
        raise ValueError("public repository id missing")
    revision = meta["sha"]
    url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{urllib.parse.quote(filename)}"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        receipt_path=path.with_suffix(path.suffix+".receipt.json")
        if receipt_path.exists():
            receipt=json.loads(receipt_path.read_text())
            if receipt.get("revision")==revision and path.stat().st_size==expected and hashlib.sha256(path.read_bytes()).hexdigest()==receipt.get("sha256"):
                return {**receipt,"cachedVerified":True}
        raise FileExistsError(f"asset exists without matching verified receipt: {path}")
    temporary = path.with_suffix(path.suffix + ".part")
    last = None
    for attempt in range(3):
        try:
            require_disk(path, expected)
            digest = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as stream:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > expected:
                        raise ValueError("download larger than pinned metadata")
                    stream.write(chunk)
                    digest.update(chunk)
            if size != expected:
                raise ValueError(f"incomplete asset: {size}/{expected}")
            actual = digest.hexdigest()
            expected_digest = entry.get("lfs", {}).get("oid")
            if expected_digest and expected_digest.removeprefix("sha256:") != actual:
                raise ValueError("LFS content digest mismatch")
            temporary.rename(path)
            receipt = {"dataset":dataset,"file":filename,"revision":revision,"url":url,"bytes":size,"sha256":actual}
            path.with_suffix(path.suffix+".receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
            return receipt
        except Exception as error:
            last = error
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed for {dataset}/{filename}: {last}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset")
    parser.add_argument("files", nargs="*")
    parser.add_argument("--file-list", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    args=parser.parse_args()
    if not 1 <= args.workers <= 4:
        raise ValueError("invalid download concurrency")
    files=list(args.files)
    if args.file_list:
        listed=json.loads(args.file_list.read_text())
        if not isinstance(listed,list) or not all(isinstance(s,str) for s in listed):
            raise ValueError("file list must contain strings")
        files.extend(listed)
    files=sorted(set(files))
    if not files:
        raise ValueError("no assets selected")
    meta=json.loads((ROOT/".mentat/benchmark-data/metadata"/f"{args.dataset}.json").read_text())
    known={f["rfilename"]:f.get("size",f.get("lfs",{}).get("size")) for f in meta["siblings"]}
    if any(not isinstance(known.get(name),int) for name in files):
        raise ValueError("selected asset lacks pinned byte size")
    require_disk(ROOT,sum(known[name] for name in files))
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for receipt in pool.map(lambda name:download(args.dataset,name),files):
            print(json.dumps(receipt),flush=True)
