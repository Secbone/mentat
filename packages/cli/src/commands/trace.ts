import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestRunDir } from "../lib/paths";

export function traceCommand(args: string[]): number {
  const dirArg = args.find((arg) => !arg.startsWith("-"));
  const raw = args.includes("--raw");
  const dir = dirArg ?? latestRunDir();
  if (!dir) {
    process.stderr.write("trace: no run directory found (run `mentat iterate` first)\n");
    return 1;
  }
  const tracePath = join(dir, "trace.jsonl");
  if (!existsSync(tracePath)) {
    process.stderr.write(`trace: no trace.jsonl in ${dir}\n`);
    return 1;
  }
  const all = args.includes("--all");
  process.stdout.write(`run: ${dir}${raw ? " (raw)" : ""}\n`);
  const lines = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (raw) {
      process.stdout.write(`${line}\n`);
      continue;
    }
    let event: { ts?: number; type?: string; data?: { type?: string } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      process.stdout.write(`${line}\n`);
      continue;
    }
    // Collapse token-level deltas and per-event usage unless --all is passed.
    if (
      !all &&
      event.type === "agent.event" &&
      (event.data?.type === "message.delta" ||
        event.data?.type === "message.reasoning" ||
        event.data?.type === "usage")
    ) {
      continue;
    }
    const time = event.ts ? new Date(event.ts).toISOString().slice(11, 19) : "--:--:--";
    const data = event.data === undefined ? "" : ` ${JSON.stringify(event.data)}`;
    process.stdout.write(`${time}  ${event.type ?? "?"}${data}\n`);
  }
  return 0;
}
