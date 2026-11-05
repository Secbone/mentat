import { describe, expect, it } from "vitest";
import { type CommandRunner, GhCliGitHubApi } from "./gh-cli";

const repoEvents = [
  {
    id: "1",
    type: "IssuesEvent",
    created_at: "2026-11-06T00:00:00.000Z",
    actor: { login: "alice", type: "User" },
    payload: {
      issue: {
        number: 12,
        title: "Bug",
        body: "please fix @mentat",
        html_url: "https://github.com/acme/app/issues/12",
      },
    },
  },
  {
    id: "2",
    type: "IssueCommentEvent",
    created_at: "2026-11-06T00:01:00.000Z",
    actor: { login: "dependabot[bot]", type: "Bot" },
    payload: {
      issue: { number: 12, title: "Bug" },
      comment: { body: "bump", html_url: "https://github.com/acme/app/issues/12#c2" },
    },
  },
  {
    id: "3",
    type: "CheckRunEvent",
    created_at: "2026-11-06T00:02:00.000Z",
    actor: { login: "github-actions[bot]", type: "Bot" },
    payload: {
      check_run: {
        name: "tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/app/checks/3",
        check_suite: { head_branch: "main" },
      },
    },
  },
];

describe("GhCliGitHubApi", () => {
  it("maps repository events and filters by since", async () => {
    const run: CommandRunner = async (args) => {
      expect(args[0]).toBe("api");
      return JSON.stringify(repoEvents);
    };
    const api = new GhCliGitHubApi({ run });
    const events = await api.events({
      repo: "acme/app",
      since: "2026-11-06T00:00:30.000Z",
    });
    expect(events.map((event) => event.kind)).toEqual(["comment", "ci"]);
    expect(events[0]).toMatchObject({ number: 12, bot: true, body: "bump" });
    expect(events[1]).toMatchObject({ branch: "main", status: "failure" });
  });

  it("posts a comment and maps 404 to gone", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (args) => {
      calls.push(args);
      return "{}";
    };
    const api = new GhCliGitHubApi({ run });
    await expect(api.comment({ repo: "acme/app", number: 12, body: "done" })).resolves.toBe("sent");
    expect(calls[0]).toContain("repos/acme/app/issues/12/comments");

    const gone = new GhCliGitHubApi({
      run: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    });
    await expect(gone.comment({ repo: "acme/app", number: 12, body: "x" })).resolves.toBe("gone");
  });
});
