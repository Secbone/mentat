# Task: implement the ACP transport for Mentat

Implement `createAcpAdapter` in `packages/transport-acp/src/adapter.ts` (re-exported
from `src/index.ts`) so that the frozen contract test
`src/adapter.contract.test.ts` passes.

## Interface (defined by the frozen test)

```ts
export function createAcpAdapter(options: {
  binary: string;
  baseArgs?: string[];
  id?: string;
  env?: Record<string, string>;
}): HarnessAdapter;
```

`HarnessAdapter` is `@mentat/core`'s interface: `{ id, label?, capabilities(), createSession(options, deps?) }`.
`createSession` returns a `SessionHandle`: `{ id, send(input, options?), interrupt(), subscribe(listener), dispose() }`.
Emit the normalized `AgentEvent`s (`run.started`, `message.delta`, `message.completed`, `run.settled`).

## Wire protocol (Agent Client Protocol, newline-delimited JSON-RPC over stdio)

The frozen stub agent `src/__fixtures__/stub-acp-agent.mjs` is the ground truth.
Read it. It is spawned as `binary baseArgs...`. Talk to it like this:

- `initialize` → `{ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name, version } }`;
  result carries `protocolVersion` / `agentCapabilities`.
- `session/new` `{ cwd, mcpServers: [] }` → result `{ sessionId }`.
- `session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }` → streams
  `session/update` notifications `{ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }`
  then responds `{ stopReason: "end_turn" | "cancelled" | ... }`.
- `session/cancel` `{ sessionId }` (notification) cancels the running prompt.

Map `session/update` `agent_message_chunk` text to `message.delta`; on the prompt
response emit `message.completed` (full accumulated text) and `run.settled`
(`cancelled` → `"aborted"`, otherwise `"done"`). `interrupt()` sends `session/cancel`.

## Constraints

- No new dependencies; use `node:child_process` + `node:events`/streams and JSON.
- Do not edit the frozen test, the stub fixture, or anything under `packages/core`,
  `packages/iterate`, `packages/transport-pi` (they are protected and will be rejected).
- Must pass `pnpm typecheck && pnpm test`.
