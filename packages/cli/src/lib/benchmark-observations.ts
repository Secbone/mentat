import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectTrajectory,
  memoryAttribution,
  readTrajectory,
  recallAttribution,
  resolveEventData,
} from "@mentat/observability";

export function benchmarkObservations(dir: string | undefined) {
  const sessionIds = new Set<string>(),
    models: unknown[] = [];
  if (dir)
    for (const event of readTrajectory(dir)) {
      const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
      if (event.type === "adapter.diagnostic" && data?.code === "ACP_MODEL_CONFIRMED")
        models.push(JSON.parse(String(data.message)));
      if (event.type === "adapter.protocol") {
        const wire = data?.data as { result?: { sessionId?: unknown } } | undefined;
        if (typeof wire?.result?.sessionId === "string") sessionIds.add(wire.result.sessionId);
      }
    }
  let accounting: {
    status: string;
    sessions: Array<{ cost?: number | null }>;
    missing?: string[];
    error?: string;
  };
  try {
    accounting = JSON.parse(
      execFileSync(
        "python3",
        [fileURLToPath(new URL("./benchmark-accounting.py", import.meta.url))],
        { input: JSON.stringify([...sessionIds]), encoding: "utf8", timeout: 10000 },
      ),
    );
  } catch (error) {
    accounting = { status: "unavailable", sessions: [], error: String(error) };
  }
  const costs = accounting.sessions.map((s) => s.cost);
  const costUsd =
    accounting.status === "complete" &&
    sessionIds.size > 0 &&
    costs.length === sessionIds.size &&
    costs.every((c) => typeof c === "number" && Number.isFinite(c) && c >= 0)
      ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      : null;
  return {
    nativeSessionIds: [...sessionIds],
    models,
    accounting,
    costUsd,
    trajectory: dir ? inspectTrajectory(dir) : null,
    memory: dir ? memoryAttribution(dir) : null,
    recall: dir ? recallAttribution(dir) : null,
  };
}
