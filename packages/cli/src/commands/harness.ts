import { createDefaultRegistry } from "../lib/registry";

export function harnessCommand(args: string[]): number {
  if (args[0] !== "list") {
    process.stderr.write("usage: mentat harness list\n");
    return 1;
  }
  for (const adapter of createDefaultRegistry().list()) {
    const capabilities = adapter.capabilities();
    const flags = Object.entries(capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(",");
    process.stdout.write(`${adapter.id}\t${adapter.label ?? ""}\t${flags}\n`);
  }
  return 0;
}
