"""Harness Harbor custom-agent bridge that runs Mentat as the RSI-Exam subject.

RSI-Exam tasks are executed by Harbor. Harbor resolves agents by name or by a
local import path (``module.path:ClassName``), which lets us plug Mentat in
without publishing a plugin. This module installs Node + the Mentat checkout
inside the task's agent container and then runs Mentat's one-turn bench bridge
(``scripts/past-bench-agent.ts``) against the rendered instruction.

Status: scaffolding. It loads and is introspectable by Harbor
(``harbor agent schema <path>:MentatAgent``), but a full run additionally needs
the "model wiring" step (see README) so Mentat's inner harness reaches Harbor's
model endpoint inside the sandbox. Treat this as the minimal bridge, not a
finished public-leaderboard agent.

Environment knobs (host side, read via Harbor's agent env):
  MENTAT_REPO     git URL to clone (default: this project's public repo)
  MENTAT_HARNESS  Mentat harness id to drive: pi | acp | fake (default: pi)
  MENTAT_MODEL    Mentat model id (default: the Harbor-resolved model name)
"""

from __future__ import annotations

import base64
import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_MENTAT_REPO = "https://github.com/Secbone/mentat.git"
_REMOTE_MENTAT = "/opt/mentat"


class MentatAgent(BaseInstalledAgent):
    """Install and drive the Mentat host inside an RSI-Exam task container."""

    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)
    options_model = InstalledAgentOptions
    options: InstalledAgentOptions

    @staticmethod
    @override
    def name() -> str:
        return "mentat"

    @override
    def get_version_command(self) -> str | None:
        return f". ~/.nvm/nvm.sh; node --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        repo = self._get_env("MENTAT_REPO") or _MENTAT_REPO
        await self.ensure_system_dependencies(environment, ("curl", "git", "ca_certificates"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "npm install -g --ignore-scripts pnpm@latest >/dev/null 2>&1; "
                f"[ -d {_REMOTE_MENTAT}/.git ] || "
                f"git clone --depth 1 {shlex.quote(repo)} {_REMOTE_MENTAT}; "
                f"cd {_REMOTE_MENTAT} && pnpm install --frozen-lockfile=false"
            ),
            timeout_sec=self.DEFAULT_SETUP_TIMEOUT_SEC * 6,
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        access = self.model_connection
        harness = self._get_env("MENTAT_HARNESS") or "pi"
        model = self._get_env("MENTAT_MODEL") or self.model_name or ""
        timeout_ms = 12 * 60 * 60 * 1000

        # Model wiring: hand the resolved Harbor connection to Mentat's harness.
        # The exact env depends on the harness provider; passthrough keeps it flat.
        env = dict(access.env)

        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        command = (
            ". ~/.nvm/nvm.sh; "
            f"cd {_REMOTE_MENTAT} && "
            f"echo {shlex.quote(encoded)} | base64 -d | "
            f"node --import tsx scripts/past-bench-agent.ts "
            f"--cwd /app "
            f"--harness {shlex.quote(harness)} "
            f"{('--model ' + shlex.quote(model) + ' ') if model else ''}"
            f"--timeout-ms {timeout_ms} "
            f"2>&1 | tee {shlex.quote(str(self.environment_logs_dir / 'mentat.json'))}"
        )
        await self.exec_as_agent(environment, command=command, env=env)
