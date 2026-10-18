// Minimal Mentat subject bridge for a PAST-Bench CLI agent adapter.
//
// PAST-Bench's `_OneShotCliAdapter` shells out to a coding CLI with the task
// prompt on stdin and parses a single JSON result. This script plays that role
// for Mentat: it runs one Mentat assistant host turn (harness + model via
// Mentat's own registry/credentials) and prints {final_output, usage, reason}.
//
// Usage:
//   node --import tsx scripts/past-bench-agent.ts \
//     --cwd <workdir> --harness <pi|acp|fake> [--model <id>] [--timeout-ms <n>] \
//     [--memory <file>] [--experience <dir>] [--log-dir <dir>]
// < prompt-on-stdin
import { createAssistantHost, createDefaultRegistry } from "@mentat/host";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const cwd = arg("--cwd") ?? process.cwd();
  const harnessId = arg("--harness") ?? "pi";
  const model = arg("--model");
  const timeoutMs = Number(arg("--timeout-ms") ?? "600000") || 600000;
  const memoryPath = arg("--memory") ?? `${cwd}/.mentat-memory.json`;
  const experienceDir = arg("--experience") ?? `${cwd}/.mentat-experience`;
  const logDir = arg("--log-dir");

  const prompt = (await readStdin()).trim();
  const registry = createDefaultRegistry("full");
  if (!registry.has(harnessId)) {
    process.stderr.write(`past-bench-agent: unknown harness "${harnessId}"\n`);
    process.exit(2);
  }

  const host = createAssistantHost({
    cwd,
    adapter: registry.get(harnessId),
    reflectionAdapter: createDefaultRegistry("full").get(harnessId),
    ...(model ? { model } : {}),
    memoryPath,
    experienceDir,
    timeoutMs,
    permissionMode: "full",
    permission: { request: () => "allow" },
    ...(logDir ? { logDir } : {}),
  });
  try {
    const session = await host.open();
    const { result } = await host.turn(session, prompt, { timeoutMs });
    process.stdout.write(
      `${JSON.stringify({
        final_output: result.text ?? "",
        reason: result.reason,
        error: result.error ?? null,
        usage: {
          input_tokens: result.usage?.inputTokens ?? 0,
          output_tokens: result.usage?.outputTokens ?? 0,
        },
      })}\n`,
    );
  } finally {
    await host.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `past-bench-agent: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
