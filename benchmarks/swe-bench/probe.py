"""Small, pinned SWE-bench Pro V2 evaluation; original Harbor tasks and verifier.

Runs each case sequentially: oracle, empty patch, Mentat, fresh-container replay.
All attempts have separate job directories. Never turns infrastructure errors into scores.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import tomllib

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_IDS = [
    "instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan",
    "instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2",
    "instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26",
]


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_guarded(command, log, env, timeout_sec):
    """Stop the owned process group if disk reserve is crossed during a stage."""
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + timeout_sec
    next_vm_check = 0.0
    try:
        while process.poll() is None:
            free = shutil.disk_usage(ROOT).free
            if free < 30 * 1024**3:
                raise RuntimeError(f"host disk reserve crossed during execution: {free} bytes free; 30 GiB required")
            if time.monotonic() >= deadline:
                raise RuntimeError("stage wall-clock timeout")
            if time.monotonic() >= next_vm_check:
                capacity(image_cached=True, stage_running=True)
                next_vm_check = time.monotonic() + 30
            time.sleep(2)
        return process.returncode
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def capacity(image_cached=False, stage_running=False):
    host = shutil.disk_usage(ROOT).free
    profile = os.environ.get("COLIMA_PROFILE", "default")
    result = subprocess.run(["colima", "--profile", profile, "ssh", "--", "df", "-Pk", "/var/lib/docker"], capture_output=True, text=True, timeout=30, check=True)
    docker = int(result.stdout.strip().splitlines()[-1].split()[3]) * 1024
    headroom = (0 if stage_running else 2 if image_cached else 8) * 1024**3
    report = {"hostFreeBytes": host, "dockerFreeBytes": docker, "hostReserveBytes": 30 * 1024**3, "dockerReserveBytes": 5 * 1024**3, "runtimeHeadroomBytes": headroom, "imageCached": image_cached, "colimaProfile": profile}
    # Already-loaded images need writable-layer headroom, not another full download.
    if host < 30 * 1024**3 + headroom or docker < 5 * 1024**3 + headroom:
        raise RuntimeError("insufficient headroom for next task: " + json.dumps(report))
    return report


def trial(job):
    paths = list(job.glob("*/result.json"))
    if len(paths) != 1:
        return {"status": "infrastructure-error", "error": f"expected one trial result; found {len(paths)}", "reward": None}
    row = json.loads(paths[0].read_text())
    rewards = (row.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward")
    error = row.get("exception_info")
    if error or type(reward) not in (int, float) or reward not in (0, 1):
        return {"status": "infrastructure-error", "error": error or "missing binary reward", "reward": None, "trial": str(paths[0])}
    return {"status": "completed", "reward": reward, "trial": str(paths[0])}


def cached_calibration(source, manifest, case, image_identity):
    if source is None:
        return {}
    previous = json.loads((source / "manifest.json").read_text())
    if previous["upstreamRevision"] != manifest["upstreamRevision"] or previous["tasks"].get(case) != manifest["tasks"][case] or previous.get("runtime") != manifest.get("runtime"):
        return {}
    rows = json.loads((source / "results.json").read_text())["cases"]
    row = next((r for r in rows if r["id"] == case), {})
    if row.get("imageIdentity") != image_identity:
        return {}
    stages = {}
    for stage, reward in [("oracle", 1), ("empty", 0)]:
        old = row.get("stages", {}).get(stage, {})
        path = Path(old.get("trial", "")).resolve()
        if not path.is_relative_to(source.resolve()) or not path.is_file():
            return {}
        if json.loads(path.read_text()).get("task_name", "").rsplit("/", 1)[-1] != case:
            return {}
        result = trial(path.parent.parent)
        if result["status"] != "completed" or result["reward"] != reward:
            return {}
        stages[stage] = {**result, "reusedCalibrationFrom": str(source), "artifactSha256": digest(path), "elapsedSeconds": 0}
    return stages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, default=ROOT / ".mentat/upstream/swe-bench-pro-sparse")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="opencode-go/deepseek-v4.1-flash")
    parser.add_argument("--limit", type=int, choices=[1, 2, 3], default=3)
    parser.add_argument("--start-index", type=int, choices=[0, 1, 2], default=0)
    parser.add_argument("--calibration-from", type=Path)
    parser.add_argument("--timeout-ms", type=int, default=600000)
    parser.add_argument("--max-steps", type=int, default=50)
    args = parser.parse_args()
    out, upstream = args.out.resolve(), args.upstream.resolve()
    out.mkdir(parents=True)  # Existing output is rejected; no overwriting or best-of retry.
    ids = DEFAULT_IDS[args.start_index:args.start_index + args.limit]
    revision = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    subject_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    changed = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=ROOT)
    (out / "subject-tracked.diff").write_bytes(changed)
    subject_files = [ROOT / "scripts/coding-benchmark-turn.ts", Path(__file__).resolve(), Path(__file__).with_name("mentat_agent.py")]
    manifest = {"benchmark": "swe-bench-pro-v2", "track": "adapted-budget-development-sample", "upstreamRevision": revision, "subjectRevision": subject_revision, "subjectDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)), "subjectDiffSha256": hashlib.sha256(changed).hexdigest(), "bridgeFiles": {str(p.relative_to(ROOT)): digest(p) for p in subject_files}, "model": args.model, "memory": "reset-disabled", "timeoutMs": args.timeout_ms, "maxSteps": args.max_steps, "selection": "First lexicographic task in each of NodeBB, ansible and openlibrary; selected before model inference, not random or representative", "ids": ids, "tasks": {}}
    manifest["runtime"] = {
        "docker": json.loads(subprocess.check_output(["docker", "info", "--format", '{{json .}}'], text=True)),
        "dockerHost": os.environ.get("DOCKER_HOST"),
        "colimaProfile": os.environ.get("COLIMA_PROFILE", "default"),
    }
    # Keep a stable environment identity; docker info also includes changing container counts.
    info = manifest["runtime"]["docker"]
    manifest["runtime"]["docker"] = {k: info.get(k) for k in ("ID", "ServerVersion", "Architecture", "NCPU", "MemTotal", "KernelVersion", "OperatingSystem")}
    colima_home = Path(os.environ.get("COLIMA_HOME", str(Path.home() / ".colima")))
    runtime_config = colima_home / manifest["runtime"]["colimaProfile"] / "colima.yaml"
    manifest["runtime"]["virtualization"] = {
        line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in runtime_config.read_text().splitlines()
        if line.startswith(("vmType:", "rosetta:", "arch:", "cpu:", "memory:"))
    }
    for case in ids:
        directory = upstream / "v2/tasks" / case
        config = tomllib.loads((directory / "task.toml").read_text())
        files = {str(p.relative_to(directory)): digest(p) for p in sorted(directory.rglob("*")) if p.is_file()}
        manifest["tasks"][case] = {"image": config["environment"]["docker_image"], "files": files}
    write(out / "manifest.json", manifest)
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(Path(__file__).parent), str(upstream / "v2/tooling")])}
    # Task images are amd64, but the egress sidecar follows the Docker daemon's
    # native architecture. A global override incorrectly forces both to amd64.
    env.pop("DOCKER_DEFAULT_PLATFORM", None)
    harbor = ROOT / ".mentat/venvs/swe-bench/bin/harbor"
    results = []
    write(out / "results.json", {"status": "running", "cases": results})
    for index, case in enumerate(ids):
        row = {"id": case, "stages": {}}
        results.append(row)
        write(out / "results.json", {"status": "running", "cases": results})
        try:
            image = manifest["tasks"][case]["image"]
            image_cached = subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            row["capacityBefore"] = capacity(image_cached)
            image_log = out / f"case-{index}-image.log"
            if not image_cached:
                with image_log.open("w") as log:
                    code = run_guarded(["docker", "pull", "--platform", "linux/amd64", image], log, env, 3600)
                    if code != 0:
                        raise RuntimeError(f"task image pull exited {code}")
            info = json.loads(subprocess.check_output(["docker", "image", "inspect", image, "--format", "{{json .}}"], text=True))
            if info.get("Architecture") != "amd64" or info.get("Os") != "linux":
                raise RuntimeError("task image must be linux/amd64")
            row["imageContent"] = {key: info.get(key) for key in ("Id", "Architecture", "Os", "RepoDigests", "RootFS")}
            row["imageIdentity"] = info.get("RepoDigests") or [info["Id"]]
            if image_cached:
                write(image_log, {"action": "reuse-loaded-image", **row["imageContent"]})
            cached = cached_calibration(args.calibration_from, manifest, case, row["imageIdentity"])
            for stage, agent in [("oracle", "oracle"), ("empty", "nop"), ("mentat", "mentat_agent:MentatAgent"), ("regrade", "patch_replay:PatchReplayAgent")]:
                if stage in cached:
                    row["stages"][stage] = cached[stage]
                    write(out / "results.json", {"status": "running", "cases": results})
                    print(f"{case}: reuse verified {stage} calibration", flush=True)
                    continue
                name = f"case-{index}-{stage}"
                cmd = [str(harbor), "run", "-p", str(upstream / "v2/tasks" / case), "-e", "docker", "-a", agent, "-n", "1", "--jobs-dir", str(out / "jobs"), "--job-name", name, "--quiet"]
                if stage == "mentat":
                    cmd += ["-m", args.model, "--ak", f"timeout_ms={args.timeout_ms}", "--ak", f"max_steps={args.max_steps}"]
                elif stage == "regrade":
                    cmd += ["-m", "replay", "--ak", f"source_job={out / 'jobs' / f'case-{index}-mentat'}"]
                started = time.monotonic()
                print(f"{case}: {stage}", flush=True)
                with (out / f"{name}.log").open("w") as log:
                    exit_code = run_guarded(cmd, log, env, 3900)
                result = trial(out / "jobs" / name)
                result.update(exitCode=exit_code, elapsedSeconds=time.monotonic()-started)
                row["stages"][stage] = result
                write(out / "results.json", {"status": "running", "cases": results})
                if stage in ("oracle", "empty") and (result["status"] != "completed" or result["reward"] != (1 if stage == "oracle" else 0)):
                    raise RuntimeError(f"{stage} calibration failed; model not run")
                if stage == "mentat":
                    agent_dir = Path(result.get("trial", "")).parent / "agent"
                    if not (agent_dir / "bridge.json").is_file() or not (agent_dir / "model.patch").is_file():
                        raise RuntimeError("subject did not reach patch capture; no model score")
                    if not (agent_dir / "host/response.json").is_file():
                        raise RuntimeError("subject transport failed; no verified model response")
                    response = json.loads((agent_dir / "host/response.json").read_text())
                    if response.get("result", {}).get("reason") == "error":
                        raise RuntimeError("subject runtime error; keep patch but withhold model score")
                if stage == "regrade" and result["status"] != "completed":
                    raise RuntimeError("fresh-container grading failed")
            row["reward"] = row["stages"]["regrade"]["reward"]
            row["status"] = "completed"
        except Exception as error:
            row.update(status="infrastructure-error", reward=None, error=str(error))
        write(out / "results.json", {"status": "running", "cases": results})
    complete = [r for r in results if r["status"] == "completed"]
    write(out / "results.json", {"status": "completed" if len(complete) == len(ids) else "incomplete", "planned": len(ids), "scored": len(complete), "resolved": sum(r["reward"] for r in complete), "resolvedRate": sum(r["reward"] for r in complete) / len(ids) if len(complete) == len(ids) else None, "cases": results})
    return 0 if len(complete) == len(ids) else 1


if __name__ == "__main__":
    sys.exit(main())
