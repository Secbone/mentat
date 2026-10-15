import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectTrajectory,
  readTrajectory,
  resolveEventData,
  summarizeTrajectory,
} from "@mentat/observability";
import { latestRunDir } from "../lib/paths";

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
export async function traceCommand(args: string[]): Promise<number> {
  if (args[0] === "diff" || args[0] === "compare") {
    if (!args[1] || !args[2]) throw new Error("trace compare <before-dir> <after-dir>");
    process.stdout.write(
      `${JSON.stringify({ before: summarizeTrajectory(args[1]), after: summarizeTrajectory(args[2]) }, null, 2)}\n`,
    );
    return 0;
  }
  if (args[0] === "feedback") {
    const dir = args[1];
    const turnId = option(args, "--turn");
    const correction = option(args, "--correction");
    const scoreArg = option(args, "--score");
    if (!dir || !turnId)
      throw new Error("trace feedback <dir> --turn <id> [--score 0..1] [--correction <text>]");
    const score = scoreArg === undefined ? undefined : Number(scoreArg);
    if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1))
      throw new Error("score must be 0..1");
    const events = readTrajectory(dir);
    if (!events.some((event) => event.turnId === turnId)) throw new Error("unknown turn");
    const { redact } = await import("@mentat/observability");
    appendFileSync(
      join(dir, "feedback.jsonl"),
      `${JSON.stringify(redact({ schemaVersion: 1, traceId: events[0]?.traceId, turnId, ts: Date.now(), source: "user", score, correction }))}\n`,
      { mode: 0o600 },
    );
    return 0;
  }
  const dir = args[0] && !args[0].startsWith("-") ? args[0] : latestRunDir();
  if (!dir) {
    process.stderr.write("trace: no run directory found\n");
    return 1;
  }
  if (!existsSync(join(dir, "events.jsonl"))) {
    const legacy = join(dir, "trace.jsonl");
    if (!existsSync(legacy)) {
      process.stderr.write(`trace: no log in ${dir}\n`);
      return 1;
    }
    process.stdout.write(readFileSync(legacy, "utf8"));
    return 0;
  }
  if (args.includes("--summary") || args.includes("--check")) {
    const value = summarizeTrajectory(dir);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return args.includes("--check") &&
      (value.violations.length ||
        value.gaps ||
        ["running", "incomplete", "interrupted"].includes(value.status))
      ? 1
      : 0;
  }
  if (args.includes("--tree") && !args.includes("--follow")) {
    const events = readTrajectory(dir);
    const nodes = new Map<string, { parent?: string; events: typeof events }>();
    const root = events[0]?.traceId ?? "trace";
    for (const event of events) {
      const id = event.spanId ?? root;
      const node = nodes.get(id) ?? { events: [] };
      if (event.parentSpanId) node.parent = event.parentSpanId;
      node.events.push(event);
      nodes.set(id, node);
    }
    const visited = new Set<string>();
    const print = (id: string, depth: number) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = nodes.get(id);
      if (!node) return;
      process.stdout.write(`${"  ".repeat(depth)}${id}\n`);
      for (const event of node.events) {
        const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
        if (
          !args.includes("--all") &&
          (data?.type === "message.delta" || data?.type === "message.reasoning")
        )
          continue;
        process.stdout.write(
          `${"  ".repeat(depth + 1)}${event.type} ${JSON.stringify(data ?? null)}\n`,
        );
      }
      for (const [child, value] of nodes) if (value.parent === id) print(child, depth + 1);
    };
    for (const [id, node] of nodes) if (!node.parent || !nodes.has(node.parent)) print(id, 0);
    for (const id of nodes.keys()) if (!visited.has(id)) print(id, 0);
    return 0;
  }
  const tool = option(args, "--tool");
  let printed = 0;
  for (;;) {
    const events = readTrajectory(dir);
    for (const event of events.slice(printed)) {
      const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
      if (
        args.includes("--errors") &&
        !/error|violation|gap/.test(event.type) &&
        !data?.error &&
        !data?.isError &&
        data?.reason !== "error"
      )
        continue;
      if (args.includes("--context") && !/context|prompt/.test(event.type)) continue;
      if (args.includes("--memory") && !/memory|reflection/.test(event.type)) continue;
      if (tool && data?.id !== tool) continue;
      if (args.includes("--raw")) {
        process.stdout.write(`${JSON.stringify({ ...event, data })}\n`);
        continue;
      }
      if (
        !args.includes("--all") &&
        (data?.type === "message.delta" || data?.type === "message.reasoning")
      )
        continue;
      process.stdout.write(
        `${args.includes("--tree") && event.spanId ? "  " : ""}${new Date(event.ts).toISOString()} ${event.turnId ?? "-"} ${event.type} ${JSON.stringify(data ?? null)}\n`,
      );
    }
    printed = events.length;
    if (!args.includes("--follow")) break;
    if (inspectTrajectory(dir).status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 0;
}
