# @mentat/source-github

GitHub repository events as a Mentat `SourceKind`.

- `GitHubSource.poll()` reads repository events, maps Issue, PR, review,
  comment and CI events to `Trigger`s, and persists a `since` read position
  plus a bounded seen-id set so a restart does not replay.
- `GitHubSource.channel()` returns an `OutboxTransport`; `Outbox` can send
  acknowledgements, answers and results as issue/PR comments.
- `GhCliGitHubApi` uses `gh api repos/{owner}/{repo}/events` and
  `POST /repos/{owner}/{repo}/issues/{number}/comments`; tests inject the
  command runner, so no network or credentials are needed.
- `FileSourceState` stores the read position atomically under a lock;
  `MemorySourceState` is for tests.

GitHub notifications are not used: repository events carry the actor and the
payload needed for gate/assessment. A 404/410 on a comment settles as `gone`.
