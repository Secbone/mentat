/**
 * Manual network smoke for the GitHub Source. Requires `gh auth login`; it is
 * typechecked by `pnpm check` but not run there. Reads a public repository and
 * checks a 404 comment without writing anything.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSourceState, GhCliGitHubApi, GitHubSource } from "@mentat/source-github";

const repo = process.env.MENTAT_GITHUB_SMOKE_REPO ?? "cli/cli";
const api = new GhCliGitHubApi({ perPage: 30, maxPages: 1 });
const events = await api.events({ repo });
if (events.length === 0) throw new Error(`no events returned for ${repo}`);
const state = new FileSourceState(
  join(mkdtempSync(join(tmpdir(), "mentat-gh-smoke-")), "state.json"),
);
const source = new GitHubSource({ api, state, repo, agentLogin: "mentat-smoke" });
const triggers = await source.poll();
if (triggers.length === 0) throw new Error("no triggers mapped");
if ((await source.poll()).length !== 0) throw new Error("read position replayed events");
const gone = await api.comment({ repo, number: 999999999, body: "mentat smoke" });
if (gone !== "gone") throw new Error(`expected gone for a missing issue, got ${gone}`);
console.log(
  JSON.stringify(
    {
      repo,
      events: events.length,
      kinds: [...new Set(events.map((event) => event.kind))],
      triggers: triggers.length,
      threads: [...new Set(triggers.map((trigger) => trigger.thread))].slice(0, 4),
      since: state.get("since"),
      missingComment: gone,
    },
    null,
    2,
  ),
);
