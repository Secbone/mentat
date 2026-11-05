import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubSource } from "./source";
import { FileSourceState, MemorySourceState } from "./state";
import type { GitHubApi, GitHubEvent } from "./types";

function event(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: "e1",
    at: "2026-11-06T00:00:00.000Z",
    kind: "issue",
    repo: "acme/app",
    number: 12,
    actor: "alice",
    bot: false,
    body: "please fix @mentat",
    title: "Bug",
    url: "https://github.com/acme/app/issues/12",
    ...overrides,
  };
}

function api(events: GitHubEvent[], sent: unknown[] = []): GitHubApi {
  return {
    async events({ since }) {
      return events.filter((item) => !since || item.at > since);
    },
    async comment(input) {
      sent.push(input);
      return "sent";
    },
  };
}

describe("GitHubSource", () => {
  it("maps Issue, PR, comment and CI events to Triggers", async () => {
    const source = new GitHubSource({
      api: api([
        event({ id: "e1", kind: "issue", number: 12 }),
        event({ id: "e2", kind: "pull_request", number: 13, body: "PR body" }),
        event({ id: "e3", kind: "comment", number: 12, body: "comment", bot: true }),
        event({
          id: "e4",
          kind: "ci",
          number: undefined,
          branch: "main",
          body: "tests",
          status: "failure",
        }),
      ]),
      state: new MemorySourceState(),
      repo: "acme/app",
      agentLogin: "mentat",
    });

    const triggers = await source.poll();
    expect(triggers).toHaveLength(4);
    expect(triggers[0]).toMatchObject({
      source: "github:acme/app",
      thread: "github:acme/app#12",
      addressed: "mention",
      meta: { scope: "issue", channel: "github:acme/app#12" },
    });
    expect(triggers[1]).toMatchObject({
      thread: "github:acme/app#13",
      addressed: "none",
      meta: { scope: "pull_request" },
    });
    expect(triggers[2]).toMatchObject({ bot: true, thread: "github:acme/app#12" });
    expect(triggers[3]).toMatchObject({
      thread: "github:acme/app:ci:main",
      meta: { scope: "ci" },
    });
  });

  it("does not replay seen events and advances the read position", async () => {
    const events = [event({ id: "e1" })];
    const state = new MemorySourceState();
    const source = new GitHubSource({
      api: api(events),
      state,
      repo: "acme/app",
      agentLogin: "mentat",
    });
    expect(await source.poll()).toHaveLength(1);
    expect(await source.poll()).toHaveLength(0);
    expect(state.get("since")).toBe(events[0]?.at);
  });

  it("writes a comment through the Channel", async () => {
    const sent: unknown[] = [];
    const source = new GitHubSource({
      api: api([], sent),
      state: new MemorySourceState(),
      repo: "acme/app",
      agentLogin: "mentat",
    });
    await expect(
      source.channel().send({
        channel: "github:acme/app#12",
        purpose: "answer",
        text: "done",
      }),
    ).resolves.toBe("sent");
    expect(sent).toEqual([{ repo: "acme/app", number: 12, body: "done" }]);
    await expect(
      source.channel().send({ channel: "github:other/repo#1", purpose: "answer", text: "x" }),
    ).resolves.toBe("gone");
  });
});

describe("FileSourceState", () => {
  it("persists read positions across instances", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mentat-source-state-")), "state.json");
    const state = new FileSourceState(path);
    state.set("since", "2026-11-06T00:00:00.000Z");
    const reloaded = new FileSourceState(path);
    expect(reloaded.get("since")).toBe("2026-11-06T00:00:00.000Z");
  });
});
