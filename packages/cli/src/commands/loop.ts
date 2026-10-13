import { runDemoLoop } from "@mentat/core";
import { runMemoryEvolutionDemo } from "@mentat/memory";

export async function loopCommand(args: string[]): Promise<number> {
  const kind = args[0];
  if (kind !== "demo" && kind !== "memory") {
    process.stderr.write("usage: mentat loop demo|memory\n");
    return 1;
  }
  const result = kind === "memory" ? await runMemoryEvolutionDemo() : await runDemoLoop();

  const metrics = new Set<string>();
  for (const record of result.records) {
    for (const signal of record.after ?? []) metrics.add(signal.name);
  }
  const metricNames = [...metrics];

  process.stdout.write(`iter  child      gate   accepted  ${metricNames.join("  ")}\n`);
  for (const record of result.records) {
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    const values = metricNames.map((name) =>
      String(record.after?.find((signal) => signal.name === name)?.value ?? "-"),
    );
    const verdict = record.accepted ? "yes" : `no (${record.reason ?? "rejected"})`;
    process.stdout.write(
      `${String(record.iteration).padEnd(5)} ${record.childId.padEnd(10)} ${gate.padEnd(6)} ${(record.accepted ? "yes" : "no").padEnd(9)} ${values.join("  ").padEnd(14)} ${record.accepted ? "" : verdict}\n`,
    );
  }
  process.stdout.write(`\narchive: ${result.archive.size()} candidates, best=${result.best.id}\n`);
  return 0;
}
