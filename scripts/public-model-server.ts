/** Local, text-only model bridge for public benchmark subjects and upstream judges.
 * It exposes the actual OpenCode model id and rejects unsupported tools/modalities.
 * ACP cannot enforce OpenAI sampling parameters: every request records that limitation.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { assert } from "@mentat/benchmark";
import { sha256 } from "@mentat/benchmark-file";
import { finalAnswerIssue } from "@mentat/core";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { FileTrajectoryStore, readTrajectory, resolveEventData } from "@mentat/observability";
import { closeSession, openSession, runTurn, type TaskInput } from "@mentat/session";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";
import { checkoutIdentity } from "../packages/cli/src/lib/benchmark-subject";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const model = option("--model", "opencode-go/deepseek-v4.1-flash");
const out = resolve(option("--out", ".mentat/public-model-server"));
const port = Number(option("--port", "8941"));
const parallel = Number(option("--parallel", "4"));
const timeoutMs = Number(option("--timeout-ms", "180000"));
assert(Number.isInteger(parallel) && parallel > 0 && parallel <= 16, "invalid concurrency");
assert(Number.isInteger(port) && port > 0 && port < 65536, "invalid port");
assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "invalid timeout");
mkdirSync(out);
const identity = checkoutIdentity(process.cwd(), join(out, "checkout-source.json"));
const transport = {
  model,
  ...identity,
  harness: "opencode-acp",
  samplingControl: "not-exposed-by-ACP",
  messageDelivery: "serialized-text; system-policy-appended-by-ACP",
  tools: "unsupported; requests with tools are rejected",
  historyProtocol: "shared-corpus-v2",
  externalHistoryProtocol: "host-materials-v1; caller records retrieval evidence",
  sourceArchive: join(out, "checkout-source.json"),
  correctiveRetries: 1,
  correctionPolicy:
    "one format-only re-ask for empty/protocol output; no grader feedback or retry of a valid wrong answer",
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(transport, null, 2), { flag: "wx" });
const registry = createDefaultRegistry("ask", {
  acp: {
    binary: "opencode",
    baseArgs: ["acp"],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        small_model: model,
        autoupdate: false,
        share: "disabled",
        instructions: [],
        plugin: [],
        agents: { title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } } },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
  },
});
const adapter = registry.get("acp");
const corpora = new Map<string, { contentSha256: string; state: string }>();
let corpusWrite: Promise<void> = Promise.resolve();
function requireDisk() {
  const disk = statfsSync(out, { bigint: true });
  assert(disk.bavail * disk.bsize >= 30n * 1024n ** 3n, "host disk reserve below 30 GiB");
}
async function ingestCorpus(body: Record<string, unknown>) {
  assert(typeof body.corpusId === "string" && body.corpusId.length > 0, "corpus id required");
  assert(Array.isArray(body.history), "history array required");
  const contentSha256 = sha256(JSON.stringify(body.history));
  const known = corpora.get(body.corpusId);
  if (known) {
    assert(known.contentSha256 === contentSha256, "corpus id reused with changed history");
    return { corpusId: body.corpusId, contentSha256, status: "ready" };
  }
  const state = join(out, "corpora", sha256(body.corpusId));
  // A failed/incomplete directory cannot silently become a successful corpus.
  mkdirSync(state, { recursive: false });
  const host = createAssistantHost({
    cwd: state,
    adapter,
    model,
    memoryPath: join(state, "memory.json"),
    experienceDir: join(state, "experience"),
    logDir: join(state, "ingestion-trace"),
    scope: sha256(body.corpusId),
    history: { maxChars: 0 },
    memoryTools: { memory: "disabled" },
    permissionMode: "deny",
    permission: { request: () => "deny" },
  });
  try {
    await host.ingestHistory(body.history);
  } finally {
    await host.close();
  }
  writeFileSync(
    join(state, "receipt.json"),
    JSON.stringify({ corpusId: body.corpusId, contentSha256 }),
  );
  corpora.set(body.corpusId, { contentSha256, state });
  return { corpusId: body.corpusId, contentSha256, status: "ready" };
}
mkdirSync(join(out, "corpora"));
let active = 0;
const queue: Array<() => void> = [];
async function acquire() {
  if (active >= parallel) await new Promise<void>((ready) => queue.push(ready));
  else active++;
}
function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
}
function transcript(messages: unknown): string {
  assert(Array.isArray(messages) && messages.length > 0, "messages required");
  return messages
    .map((m: unknown) => {
      assert(m && typeof m === "object", "invalid message");
      const message = m as Record<string, unknown>;
      assert(
        ["system", "developer", "user", "assistant"].includes(String(message.role)),
        "unsupported role",
      );
      assert(typeof message.content === "string", "only text messages supported");
      return JSON.stringify({ role: message.role, content: message.content });
    })
    .join("\n");
}
async function complete(body: Record<string, unknown>, kind: "reader" | "subject") {
  const id = randomUUID();
  const trial = join(out, "requests", id);
  const cwd = join(trial, "work");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(trial, "request.json"), JSON.stringify({ kind, body, transport }, null, 2), {
    flag: "wx",
  });
  let text: string, reason: string, evidenceDir: string | undefined;
  if (kind === "subject") {
    assert(body.input && typeof body.input === "object", "subject input required");
    assert(
      body.externalHistory === undefined || typeof body.externalHistory === "boolean",
      "invalid external history mode",
    );
    const externalHistory = body.externalHistory === true;
    assert(
      !externalHistory || (body.history === undefined && body.corpusId === undefined),
      "external history cannot also use native history",
    );
    if (externalHistory) {
      const input = body.input as TaskInput;
      assert(
        Array.isArray(input.materials) && input.materials.length > 0,
        "external history requires materials",
      );
    }
    const budget = body.historyBudgetChars ?? 12000;
    assert(
      typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 0,
      "invalid history budget",
    );
    assert(
      body.historyBefore === undefined ||
        (typeof body.historyBefore === "number" &&
          Number.isFinite(new Date(body.historyBefore).getTime())),
      "invalid temporal cutoff",
    );
    assert(body.corpusId === undefined || typeof body.corpusId === "string", "invalid corpus id");
    assert(
      body.corpusId === undefined || body.history === undefined,
      "choose corpus or inline history",
    );
    const corpus = typeof body.corpusId === "string" ? corpora.get(body.corpusId) : undefined;
    assert(body.corpusId === undefined || corpus, "corpus not ingested");
    const state = corpus?.state ?? trial;
    const host = createAssistantHost({
      cwd,
      adapter,
      model,
      memoryPath: join(state, "memory.json"),
      experienceDir: join(state, "experience"),
      logDir: join(trial, "trace"),
      scope: sha256(id),
      memoryTools: { memory: "disabled" },
      requireFinalAnswer: true,
      correctiveRetries: 1,
      ...(externalHistory
        ? {}
        : {
            history: {
              maxChars: budget,
              ...(typeof body.historyBefore === "number" ? { before: body.historyBefore } : {}),
            },
          }),
      timeoutMs,
      permissionMode: "deny",
      permission: { request: () => "deny" },
      protocolLog: true,
    });
    try {
      if (body.history !== undefined) await host.ingestHistory(body.history);
      const session = await host.open();
      const result = await host.turn(session, body.input as TaskInput, { timeoutMs });
      text = result.result.text;
      reason = result.result.reason;
      evidenceDir = host.logDir;
    } finally {
      await host.close();
    }
  } else {
    const trace = new FileTrajectoryStore(join(trial, "trace"), { metadata: transport });
    let session: Awaited<ReturnType<typeof openSession>> | undefined;
    try {
      session = await openSession(
        adapter,
        { cwd, model },
        {
          onDiagnostic: (data) => trace.emit("adapter.diagnostic", data),
          onProtocol: (data) => trace.emit("adapter.protocol", data as never),
          onPermission: { request: () => "deny" },
        },
        { timeoutMs },
      );
      const result = await runTurn(
        session,
        {
          text: transcript(body.messages),
          hostPolicy:
            "This is a closed-book answer-only request. No tools are available. Return the requested final answer, not a tool call or a promise to search. Use only the supplied evidence.",
        },
        { timeoutMs, tracer: trace, requireFinalAnswer: true, correctiveRetries: 1 },
      );
      text = result.text;
      reason = result.reason;
    } finally {
      if (session) await closeSession(session);
      await trace.close();
    }
    evidenceDir = trace.dir;
  }
  const observations = benchmarkObservations(evidenceDir);
  writeFileSync(join(trial, "verification.json"), JSON.stringify(observations, null, 2), {
    flag: "wx",
  });
  assert(observations.models.length > 0, "ACP model identity unverified");
  const outputIssue = finalAnswerIssue(text);
  const attempts: Array<{ text: string; issue: ReturnType<typeof finalAnswerIssue> | null }> = [];
  let pendingText: string | undefined;
  let correctiveTurns = 0;
  if (evidenceDir)
    for (const event of readTrajectory(evidenceDir)) {
      const data = resolveEventData(evidenceDir, event) as Record<string, unknown>;
      if (event.type === "agent.event" && data?.type === "message.completed") {
        const message = data.message as { text?: string } | undefined;
        if (typeof message?.text === "string") pendingText = message.text;
      }
      if (event.type === "output.corrective") {
        const previous = pendingText ?? "";
        attempts.push({ text: previous, issue: finalAnswerIssue(previous) ?? null });
        pendingText = undefined;
        correctiveTurns++;
      }
    }
  attempts.push({ text, issue: outputIssue ?? null });
  const first = attempts[0];
  assert(first, "missing first response");
  let retrieval: Record<string, unknown> | undefined;
  if (kind === "subject" && evidenceDir)
    for (const event of readTrajectory(evidenceDir)) {
      if (event.type !== "history.selection") continue;
      const data = resolveEventData(evidenceDir, event) as Record<string, unknown>;
      retrieval = Object.fromEntries(
        [
          "selectedIds",
          "eligibleSessions",
          "matchingChunks",
          "omittedChunks",
          "chars",
          "selectedSessions",
          "strategy",
        ].map((key) => [key, data[key]]),
      );
    }
  const result = {
    id,
    text,
    reason,
    finalAnswerIssue: outputIssue ?? null,
    attempts,
    correctiveTurns,
    firstAnswerValid: first.issue === null,
    ...(retrieval ? { retrieval } : {}),
    observations,
    evidenceDir,
    transport,
  };
  writeFileSync(join(trial, "response.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  assert(
    reason === "done" || (kind === "subject" && Boolean(outputIssue)),
    `model turn failed: ${reason}; evidence=${join(trial, "response.json")}`,
  );
  return result;
}
const server = createServer(async (req, res) => {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "GET" && req.url === "/health") {
    send(200, { ...transport, active, queued: queue.length });
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    send(200, { object: "list", data: [{ id: model, object: "model", owned_by: "opencode" }] });
    return;
  }
  if (
    req.method !== "POST" ||
    !["/v1/chat/completions", "/subject", "/history"].includes(req.url ?? "")
  ) {
    send(404, { error: "unknown route" });
    return;
  }
  let acquired = false;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= 32 * 1024 * 1024, "request too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    assert(
      body.model === undefined || body.model === model,
      "requested model does not match configured model",
    );
    assert(!body.stream, "streaming unsupported");
    assert(
      !body.tools || (Array.isArray(body.tools) && body.tools.length === 0),
      "tool requests unsupported by text bridge",
    );
    assert(!body.functions && !body.audio && !body.modalities, "non-text capabilities unsupported");
    if (req.url === "/v1/chat/completions") transcript(body.messages);
    await acquire();
    acquired = true;
    requireDisk();
    if (req.url === "/history") {
      // Ingestion is deliberately serialized so duplicate concurrent ids cannot race writes.
      const operation = corpusWrite.then(() => ingestCorpus(body));
      corpusWrite = operation.then(
        () => undefined,
        () => undefined,
      );
      send(200, await operation);
      return;
    }
    const result = await complete(body, req.url === "/subject" ? "subject" : "reader");
    if (req.url === "/subject") {
      send(200, result);
      return;
    }
    const native = result.observations.accounting.sessions as Array<{
      tokens_input?: number;
      tokens_output?: number;
    }>;
    const completeUsage = result.observations.accounting.status === "complete";
    send(200, {
      id: `chatcmpl-${result.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" },
      ],
      ...(completeUsage
        ? {
            usage: {
              prompt_tokens: native.reduce((n, s) => n + (s.tokens_input ?? 0), 0),
              completion_tokens: native.reduce((n, s) => n + (s.tokens_output ?? 0), 0),
              total_tokens: native.reduce(
                (n, s) => n + (s.tokens_input ?? 0) + (s.tokens_output ?? 0),
                0,
              ),
            },
          }
        : {}),
      mentat: { requestId: result.id, evidenceDir: result.evidenceDir, transport },
    });
  } catch (error) {
    send(400, { error: { message: String(error), type: "bridge_error" } });
  } finally {
    if (acquired) release();
  }
});
server.requestTimeout = 0;
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`${JSON.stringify({ ready: true, port, out, ...transport })}\n`),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
