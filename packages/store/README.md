# @mentat/store

Durable repositories for the Mentat control plane.

One JSON snapshot (`state.json`) is atomically replaced under a file lock. The
Engine is the single writer, so a snapshot per command is enough for the first
product slice. Move to SQLite when concurrent readers, large histories or
transactional queries matter; the `Repositories` interface stays the same.

```ts
const repos = new FileRepositories("/path/to/state");
const engine = new Engine({ repos, policy: () => policy });
```

The lock prevents two processes from replacing the same state, not two writers
from interleaving commands; run one Engine per state directory.
