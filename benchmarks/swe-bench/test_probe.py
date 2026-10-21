import json
from pathlib import Path
import tempfile
import unittest
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

from probe import cached_calibration, capacity, run_guarded, trial
from merge import merge


class ResultBoundaryTest(unittest.TestCase):
    def read(self, row):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "case").mkdir()
            (root / "case/result.json").write_text(json.dumps(row))
            return trial(root)

    def test_official_zero_is_a_measured_failure(self):
        self.assertEqual(self.read({"verifier_result": {"rewards": {"reward": 0}}})["reward"], 0)
        self.assertEqual(self.read({"verifier_result": {"rewards": {"reward": 1}}})["status"], "completed")

    def test_environment_error_never_becomes_a_zero_score(self):
        result = self.read({"exception_info": {"exception_type": "BuildFailure"}, "verifier_result": {"rewards": {"reward": 0}}})
        self.assertEqual(result["status"], "infrastructure-error")
        self.assertIsNone(result["reward"])

    def test_missing_or_nonbinary_reward_is_not_a_score(self):
        for row in [{}, {"verifier_result": {"rewards": {"reward": 0.5}}}, {"verifier_result": {"rewards": {"reward": True}}}]:
            self.assertIsNone(self.read(row)["reward"])

    def test_job_summary_is_not_a_per_task_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "result.json").write_text('{"mean": 1}')
            self.assertIsNone(trial(root)["reward"])

    def test_calibration_reuse_checks_artifact_identity_and_task_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            manifest = {"upstreamRevision": "fixed", "tasks": {"case": {"files": {"test.sh": "sha"}}}}
            stages = {}
            for stage, reward in [("oracle", 1), ("empty", 0)]:
                path = source / stage / "trial/result.json"
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({"task_name": "swebench-pro/case", "verifier_result": {"rewards": {"reward": reward}}}))
                stages[stage] = {"trial": str(path)}
            (source / "manifest.json").write_text(json.dumps(manifest))
            (source / "results.json").write_text(json.dumps({"cases": [{"id": "case", "imageIdentity": ["digest"], "stages": stages}]}))
            self.assertEqual(set(cached_calibration(source, manifest, "case", ["digest"])), {"oracle", "empty"})
            self.assertEqual(cached_calibration(source, manifest, "case", ["different-image"]), {})
            changed = {"upstreamRevision": "fixed", "tasks": {"case": {"files": {"test.sh": "changed"}}}}
            self.assertEqual(cached_calibration(source, changed, "case", ["digest"]), {})
            changed_runtime = {**manifest, "runtime": {"docker": {"ID": "different-vm"}}}
            self.assertEqual(cached_calibration(source, changed_runtime, "case", ["digest"]), {})
            path = Path(stages["oracle"]["trial"])
            value = json.loads(path.read_text())
            value["task_name"] = "swebench-pro/other-case"
            path.write_text(json.dumps(value))
            self.assertEqual(cached_calibration(source, manifest, "case", ["digest"]), {})

    def test_cached_images_keep_reserves_and_check_selected_vm(self):
        disk = SimpleNamespace(free=35 * 1024**3)
        report = SimpleNamespace(stdout="Filesystem Size Used Available Capacity Mounted\n/dev/vdb 12000000 3000000 9000000 25% /var/lib/docker\n")
        with patch("probe.shutil.disk_usage", return_value=disk), patch("probe.subprocess.run", return_value=report) as run, patch.dict("os.environ", {"COLIMA_PROFILE": "mentat-nodebb"}):
            value = capacity(image_cached=True)
            self.assertEqual(value["hostReserveBytes"], 30 * 1024**3)
            self.assertEqual(value["dockerReserveBytes"], 5 * 1024**3)
            self.assertIn("mentat-nodebb", run.call_args.args[0])
            with self.assertRaisesRegex(RuntimeError, "headroom"):
                capacity(image_cached=False)

    def test_execution_guard_stops_owned_process_when_reserve_is_crossed(self):
        owned = []
        popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = popen(*args, **kwargs)
            owned.append(process)
            return process
        with tempfile.TemporaryFile(mode="w+") as log, patch("probe.subprocess.Popen", side_effect=launch), patch("probe.shutil.disk_usage", return_value=SimpleNamespace(free=29 * 1024**3)):
            with self.assertRaisesRegex(RuntimeError, "reserve crossed"):
                run_guarded([sys.executable, "-c", "import time; time.sleep(30)"], log, dict(os.environ), 60)
        self.assertIsNotNone(owned[0].poll())


class BatchMergeTest(unittest.TestCase):
    def batch(self, root, name, case, scored, model="fixed"):
        source = root / name
        source.mkdir()
        manifest = {"upstreamRevision": "revision", "subjectRevision": "subject", "model": model, "memory": "reset-disabled", "timeoutMs": 1000, "maxSteps": 5, "ids": [case], "tasks": {case: {}}}
        (source / "manifest.json").write_text(json.dumps(manifest))
        (source / "results.json").write_text(json.dumps({"status": "completed" if scored else "incomplete", "cases": [{"id": case, "status": "completed" if scored else "infrastructure-error", "reward": 1 if scored else None}]}))
        return source

    def test_blocked_case_stays_in_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            merge([self.batch(root, "a", "a", False), self.batch(root, "b", "b", True)], root / "out")
            results = json.loads((root / "out/results.json").read_text())
            self.assertEqual((results["planned"], results["scored"], results["resolvedRate"]), (2, 1, None))

    def test_duplicate_attempts_cannot_be_best_of_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = self.batch(root, "a", "same", False), self.batch(root, "b", "same", True)
            with self.assertRaisesRegex(ValueError, "duplicate"):
                merge([a, b], root / "out")
            self.assertFalse((root / "out").exists())

    def test_incompatible_model_batches_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = self.batch(root, "a", "a", True), self.batch(root, "b", "b", True, model="different")
            with self.assertRaisesRegex(ValueError, "incompatible"):
                merge([a, b], root / "out")

    def test_runtime_changes_cannot_be_merged_as_same_experiment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = self.batch(root, "a", "a", True), self.batch(root, "b", "b", True)
            path = b / "manifest.json"
            manifest = json.loads(path.read_text())
            manifest["runtime"] = {"virtualization": {"rosetta": "true"}}
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "runtime"):
                merge([a, b], root / "out")


if __name__ == "__main__":
    unittest.main()
