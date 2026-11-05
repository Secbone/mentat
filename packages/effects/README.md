# @mentat/effects

Durable side effects and outbox receipts for the Mentat control plane.

- `EffectQueue` persists effects in one atomically replaced JSON file, coalesces
  waiting work by `kind + key`, retries with exponential backoff, and exposes
  per-kind health. `Later` defers work without counting a failure.
- `Outbox` stores a receipt for every outbound message, enqueues a `reply`
  effect, sends through a Source transport, and keeps per-Ticket/conversation
  order. A `gone` conversation settles as `dropped`.

The Engine exposes an `EffectPort` (`enqueue(kind, key, payload)`); the runtime
bridges it to the queue after the state write. This slice is a separate file
from `@mentat/store`, so a crash between the two writes is possible; one SQLite
transaction replaces both when the store moves on.
