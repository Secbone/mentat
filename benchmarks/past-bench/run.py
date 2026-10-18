#!/usr/bin/env python3
"""Run PAST-Bench with the Mentat subject adapter injected.

PAST-Bench resolves adapters from a fixed ``_ADAPTERS`` map, so we register the
Mentat adapter into that map at import time and then defer to the normal
``past-bench`` CLI. This keeps the upstream checkout unpatched.

Run with the PAST-Bench virtualenv so ``past_bench`` is importable, e.g.:

  MENTAT_ROOT=/path/to/mentat \
  MENTAT_MODEL=opencode-go/deepseek-v4.1-flash \
  /path/to/PAST-Bench/.venv/bin/python benchmarks/past-bench/run.py \
    evolve --family memory_ability/SM01_preference_adoption \
    --agent mentat \
    --registry benchmarks/past-bench/agents.mentat.yaml \
    --runtime local --no-judge --trace-dir /tmp/past-bench-smoke/sm01
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from past_bench.runtime import manager  # noqa: E402
from mentat_adapter import MentatCliAdapter  # noqa: E402

manager._ADAPTERS["mentat_cli"] = MentatCliAdapter

from past_bench.cli import main  # noqa: E402


if __name__ == "__main__":
    sys.exit(main())
