"""PAST-Bench runtime adapter that runs Mentat as the subject agent.

This is the upstream side of the minimal Mentat <-> PAST-Bench bridge. It is a
one-shot CLI adapter (like the built-in codex/claude adapters) that shells out
to ``scripts/past-bench-agent.ts`` in the Mentat checkout, passing the task
prompt on stdin and reading a single JSON result back.

It deliberately:
  * keeps the real ``HOME`` (so Mentat's Pi/OpenCode credential discovery works),
    unlike the stock CLI adapters which isolate HOME;
  * ignores PAST-Bench's provider model/key wiring and lets Mentat resolve the
    model from ``MENTAT_MODEL`` / MENTAT's own registry.

Required environment:
  MENTAT_ROOT   path to the Mentat checkout (contains scripts/past-bench-agent.ts)
Optional:
  MENTAT_NODE       node binary (default: "node")
  MENTAT_HARNESS    Mentat harness id: pi | acp | fake (default: "pi")
  MENTAT_MODEL      Mentat model id (default: this adapter entry's model_id)
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from past_bench.models.content import TextBlock
from past_bench.models.message import Message
from past_bench.models.trace import TokenUsage
from past_bench.runtime.adapters.cli_agent import _OneShotCliAdapter
from past_bench.runtime.protocol import StepResponse


class MentatCliAdapter(_OneShotCliAdapter):
    """Drive one Mentat host turn per PAST-Bench task."""

    cli_name = "mentat"

    def _run_cli(self, prompt: str) -> StepResponse:
        root = os.environ.get("MENTAT_ROOT")
        if not root:
            return StepResponse(status="error", error="MENTAT_ROOT is required for the Mentat adapter")
        script = Path(root) / "scripts" / "past-bench-agent.ts"
        if not script.exists():
            return StepResponse(status="error", error=f"Mentat bridge script not found: {script}")

        node = os.environ.get("MENTAT_NODE", "node")
        harness = os.environ.get("MENTAT_HARNESS", "pi")
        model = os.environ.get("MENTAT_MODEL") or self.request.model.model_id or ""

        command = [
            node,
            "--import",
            "tsx",
            str(script),
            "--cwd",
            str(self._work_dir),
            "--harness",
            harness,
            "--timeout-ms",
            str(self.timeout_seconds * 1000),
        ]
        if model:
            command += ["--model", model]

        # Real HOME so Mentat finds its own credentials; run node from the Mentat
        # root so the bare `tsx` loader resolves from its node_modules, while the
        # host work dir is passed explicitly via --cwd above.
        env = os.environ.copy()
        proc = subprocess.run(
            command,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds + 30,
            env=env,
            cwd=str(root),
        )

        payload = None
        for line in reversed(proc.stdout.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        if not isinstance(payload, dict):
            detail = (proc.stderr or proc.stdout or "").strip()[-1000:]
            return StepResponse(status="error", error=f"mentat returned no JSON result: {detail}")

        usage_payload = payload.get("usage") or {}
        usage = TokenUsage(
            input_tokens=int(usage_payload.get("input_tokens") or 0),
            output_tokens=int(usage_payload.get("output_tokens") or 0),
        )
        if payload.get("error"):
            return StepResponse(status="error", error=str(payload["error"]), usage=usage)

        text = str(payload.get("final_output") or "").strip()
        return StepResponse(
            status="finished",
            assistant_message=Message(role="assistant", content=[TextBlock(text=text)]),
            usage=usage,
            final_output=text,
        )
