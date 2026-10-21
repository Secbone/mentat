"""Privileged calibration diagnostics only; never a model subject or published score.

Applies the official reference patch and logs the unchanged timeout command's
exit code. Task files, time limits and test assertions remain untouched.
"""
import json
from pathlib import Path

from harbor.agents.base import BaseAgent


class DiagnosticOracle(BaseAgent):
    def __init__(self, *args, task_dir, **kwargs):
        super().__init__(*args, **kwargs)
        self.task_dir = Path(task_dir).resolve()

    @staticmethod
    def name():
        return "diagnostic-oracle"

    def version(self):
        return "timeout-exit-observation-v1"

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):
        self.logs_dir = self.logs_dir.resolve()
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        wrapper = self.logs_dir / "timeout-wrapper.sh"
        wrapper.write_text('''#!/bin/bash
log=/logs/agent/timeout-exits.log
printf 'START %s pid=%s command=' "$(date +%s.%N)" "$$" >> "$log"
printf '%q ' /usr/bin/timeout "$@" >> "$log"
printf '\\n' >> "$log"
/usr/bin/timeout "$@"
result=$?
printf 'END %s pid=%s exit=%s\\n' "$(date +%s.%N)" "$$" "$result" >> "$log"
exit "$result"
''')
        await environment.upload_file(source_path=wrapper, target_path="/usr/local/bin/timeout")
        setup = await environment.exec(command="chmod 755 /usr/local/bin/timeout; test -x /usr/bin/timeout; command -v timeout; node --version; npm --version; uname -m; free -m", timeout_sec=30)
        (self.logs_dir / "runtime.json").write_text(json.dumps({"return_code": setup.return_code, "stdout": setup.stdout, "stderr": setup.stderr}))
        if setup.return_code != 0:
            raise RuntimeError("diagnostic setup failed")
        await environment.upload_file(source_path=self.task_dir / "solution/gold_patch.diff", target_path="/tmp/reference.patch")
        result = await environment.exec(command="cd /app && git apply --verbose /tmp/reference.patch", timeout_sec=30)
        (self.logs_dir / "reference-apply.json").write_text(json.dumps({"return_code": result.return_code, "stdout": result.stdout, "stderr": result.stderr}))
        if result.return_code != 0:
            raise RuntimeError("reference patch did not apply")
