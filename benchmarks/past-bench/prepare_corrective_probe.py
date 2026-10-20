"""Create/verify the isolated one-format-correction diagnostic subject and runner.

Do not edit an in-flight subject. This derived pair preserves the primary frozen
source while making the only treatment (one format retry) explicit and hashable.
"""
import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def derived_sources():
    subject = (ROOT / "scripts/past-rsi-turn.ts").read_text()
    assert subject.count("correctiveRetries: 0") == 1
    subject = subject.replace("correctiveRetries: 0", "correctiveRetries: 1")
    original = "const payload = { ...(response as object), taskTurnId: taskTurn.turnId, calls, observations };"
    assert subject.count(original) == 1
    subject = subject.replace(original,
        'const correctiveTurns = readTrajectory(traceDir).filter((event) => event.type === "output.corrective" && event.turnId === taskTurn.turnId).length;\n'
        'const payload = { ...(response as object), taskTurnId: taskTurn.turnId, correctiveTurns, firstAnswerValid: correctiveTurns === 0 && (response as {reason: string}).reason === "done", calls, observations };')
    runner = (ROOT / "benchmarks/past-bench/rsi_probe.py").read_text()
    replacements = [
        ("Path(__file__).resolve().parents[2]", "Path(__file__).resolve().parents[1]"),
        ("scripts/past-rsi-turn.ts", ".mentat/past-rsi-turn-corrected.ts"),
        ("past-native-rsi-diagnostic-v2", "past-native-rsi-diagnostic-corrective1-v1"),
        ("four-complete-families", "complete-selected-families"),
        ('validFinalAnswer=response["reason"] == "done",', 'validFinalAnswer=response["reason"] == "done", correctiveTurns=response["correctiveTurns"], firstAnswerValid=response["firstAnswerValid"],'),
        ('"no LLM communication judge",', '"no LLM communication judge", "one format-only correction allowed uniformly; no correctness feedback",'),
    ]
    for old, new in replacements:
        assert old in runner, f"source contract changed: {old}"
        runner = runner.replace(old, new)
    return {ROOT / ".mentat/past-rsi-turn-corrected.ts": subject,
            ROOT / ".mentat/past-rsi-corrected.py": runner}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    for path, source in derived_sources().items():
        if path.exists() or args.verify:
            assert path.read_text() == source, f"derived source differs: {path}"
        else:
            path.parent.mkdir(exist_ok=True)
            path.write_text(source)
        print(path.relative_to(ROOT), hashlib.sha256(source.encode()).hexdigest())
