# ADR-0007: Mentat as a DSH-hosted product with heterogeneous workers

Status: proposed (2026-11-05). To be accepted after the Phase 0 DSH spike.

## Context

DeepSeek Harness (`dsh`) is an MIT-licensed, Cordis-based agent host. Everything
— model adapters, tools, sessions, sandbox, the agent loop and the UI — is a
plugin. It already provides session logs and queries, skills, scheduling,
background jobs, subagents, worktrees, settings, telemetry and a web panel.

DeepSeek's Super-agent is an application architecture on top of DSH: a
long-lived Router that talks to people and dispatches work, and isolated Worker
sessions that execute one Ticket each. Its domain model (Source, Trigger,
Thread, Eval, Decision, Mandate, Ticket, Assignment, Subscription, Channel,
Policy) is the part DSH itself does not provide.

Mentat currently owns a parallel runtime (host, session, harnesses, transports)
plus memory, skills, workspace, observability, evaluation and evolution. Most of
that runtime overlaps DSH and is expensive to keep competitive. Mentat's durable
differentiators are evidence-based improvement: artifact identity, receipts,
frozen evaluation protocols, attribution, archive and capability distribution.

## Decision

Mentat remains a product, but is hosted by DSH:

1. **DSH is the control-plane host.** Mentat ships as Cordis plugins/bundles
   that use `ctx.sessions`, `ctx.sessionQuery`, `ctx.tools`, `ctx.systemPrompt`,
   `ctx.skills`, `ctx.schedule`, `ctx.jobs`, `ctx.agents`, settings, telemetry
   and the panel. Mentat does not reimplement these.
2. **Super-agent is the runtime reference.** Mentat implements the domain and
   Router/Worker flow as a DSH bundle, not a parallel framework.
3. **Workers are heterogeneous.** Pi, OpenCode, Codex and DSH-native sessions
   sit behind one `WorkerAdapter` contract. The Router chooses a Worker and a
   capability pack per Assignment.
4. **Self-evolution lives in the control plane.** Mentat evolves versioned
   `CapabilityPack`s (prompt, skills, memory, tools/MCP, policy, routing) and
   distributes them to Workers. Worker internals are not rewritten.
5. **A portable core stays independent.** Domain types, artifact/receipt
   contracts, evaluation protocols and the archive do not import DSH or Worker
   implementations. DSH is the first host, not the definition of the product.
6. **The old runtime becomes legacy.** `host`/`session`/`harnesses`/`transports`
   are frozen for new feature work and kept only for standalone evaluation and
   cross-engine comparison until the DSH path is proven.

## Alternatives considered

- **Become a plain DSH/Super-agent bundle.** Rejected: it discards Mentat's
  evidence/evolution layer and makes the product a branch of DeepSeek's
  application.
- **Port the whole DSH architecture into Mentat.** Rejected: it reinvents a
  mature session/tool/sandbox/UI stack and creates a permanent maintenance race.
- **Keep the current parallel runtime unchanged.** Rejected: it competes with
  the ecosystem Mentat wants to build on and cannot provide an always-on,
  multi-ticket product at reasonable cost.
- **Use DSH only as a process-level worker.** Kept as a fallback and as the
  Phase 0 integration path, but not the target: Mentat needs its Router, state,
  panel and plugins to be first-class in the host.

## Consequences

- Mentat gains DSH's session/tool/sandbox/UI ecosystem and can ship as an
  installable bundle.
- Mentat takes a dependency on a developer-preview host with breaking changes.
  Mitigation: pin versions, keep a thin adapter, and keep the portable core
  DSH-free.
- Worker capability differences must be negotiated explicitly; a single
  lowest-common-denominator interface is not acceptable.
- Evaluation must become a Worker × CapabilityPack matrix; single-worker
  improvements cannot be reported as general improvements.
- New packages are required: domain/contracts, DSH adapter, worker adapters,
  memory/skill/eval/evolve/dream plugins, sources and panel extensions.
- The existing artifact/receipt work becomes the evidence layer for capability
  distribution rather than a standalone evolution demo.
