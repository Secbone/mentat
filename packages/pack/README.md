# @mentat/pack

Versioned Capability Pack contract for Mentat Workers.

A pack is the unit the control plane evolves and distributes: prompt, skills,
memory reference, tools/MCP, policy/budget and model. `defineCapabilityPack()`
normalizes it and content-addresses the whole value, so an Assignment and its
receipt can name the exact pack that ran.

```ts
const pack = defineCapabilityPack({
  id: "worker-default",
  version: 3,
  prompt: { system: "You are a Mentat Worker.", role: "worker" },
  model: { model: "provider/model" },
  policy: { budget: { wallMs: 600_000 } },
});
```

`packRef(pack)` returns `{ id, version, digest }` for Assignment/receipt
records. A Worker adapter must reject a pack capability it cannot inject; the
current `HarnessWorker` injects prompt/model/MCP/executionPolicy and rejects
skills, memory and tool allowlists until those plugins exist.
