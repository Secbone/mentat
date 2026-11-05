import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubApi, GitHubEvent, GitHubEventKind } from "./types";

const exec = promisify(execFile);

export type CommandRunner = (args: string[]) => Promise<string>;

interface GitHubActor {
  login?: string;
  type?: string;
}

interface GitHubRepoEvent {
  id?: string;
  type?: string;
  created_at?: string;
  actor?: GitHubActor;
  payload?: Record<string, unknown>;
}

function isBot(actor: GitHubActor | undefined): boolean {
  return actor?.type === "Bot" || Boolean(actor?.login?.endsWith("[bot]"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function mapEvent(event: GitHubRepoEvent, repo: string): GitHubEvent | undefined {
  const payload = event.payload ?? {};
  const actor = event.actor ?? {};
  const at = event.created_at;
  const id = event.id;
  if (!at || !id) return undefined;

  const base = {
    id,
    at,
    repo,
    actor: actor.login ?? "unknown",
    bot: isBot(actor),
  };

  switch (event.type) {
    case "IssuesEvent": {
      const issue = asRecord(payload.issue);
      if (!issue) return undefined;
      return {
        ...base,
        kind: "issue" satisfies GitHubEventKind,
        number: number(issue.number),
        title: string(issue.title),
        body: string(issue.body) ?? "",
        url: string(issue.html_url),
      };
    }
    case "IssueCommentEvent": {
      const issue = asRecord(payload.issue);
      const comment = asRecord(payload.comment);
      if (!issue || !comment) return undefined;
      return {
        ...base,
        kind: "comment",
        number: number(issue.number),
        title: string(issue.title),
        body: string(comment.body) ?? "",
        url: string(comment.html_url),
      };
    }
    case "PullRequestEvent": {
      const pull = asRecord(payload.pull_request);
      if (!pull) return undefined;
      return {
        ...base,
        kind: "pull_request",
        number: number(pull.number),
        title: string(pull.title),
        body: string(pull.body) ?? "",
        url: string(pull.html_url),
      };
    }
    case "PullRequestReviewEvent":
    case "PullRequestReviewCommentEvent": {
      const pull = asRecord(payload.pull_request);
      const review = asRecord(payload.review) ?? asRecord(payload.comment);
      if (!pull) return undefined;
      return {
        ...base,
        kind: "review",
        number: number(pull.number),
        title: string(pull.title),
        body: string(review?.body) ?? "",
        url: string(review?.html_url) ?? string(pull.html_url),
      };
    }
    case "CheckRunEvent": {
      const check = asRecord(payload.check_run);
      const suite = asRecord(check?.check_suite);
      if (!check) return undefined;
      return {
        ...base,
        kind: "ci",
        branch: string(suite?.head_branch) ?? "default",
        body: string(check.name) ?? "check run",
        status: string(check.conclusion) ?? string(check.status),
        url: string(check.html_url),
      };
    }
    case "CheckSuiteEvent": {
      const suite = asRecord(payload.check_suite);
      if (!suite) return undefined;
      return {
        ...base,
        kind: "ci",
        branch: string(suite.head_branch) ?? "default",
        body: "check suite",
        status: string(suite.conclusion) ?? string(suite.status),
        url: string(suite.url),
      };
    }
    default:
      return undefined;
  }
}

/**
 * `gh api` implementation. Repository events carry the actor and the payload
 * needed for Issue/PR/review/CI triggers; the read position filters `since`.
 */
export class GhCliGitHubApi implements GitHubApi {
  private readonly run: CommandRunner;

  constructor(options: { run?: CommandRunner } = {}) {
    this.run =
      options.run ??
      (async (args) => {
        const { stdout } = await exec("gh", args, { maxBuffer: 8 * 1024 * 1024 });
        return stdout;
      });
  }

  async events(input: { repo: string; since?: string }): Promise<GitHubEvent[]> {
    const raw = await this.run(["api", `repos/${input.repo}/events?per_page=100`]);
    const parsed = JSON.parse(raw) as GitHubRepoEvent[];
    if (!Array.isArray(parsed)) throw new Error("GitHub events response is not an array");
    return parsed
      .map((event) => mapEvent(event, input.repo))
      .filter((event): event is GitHubEvent => event !== undefined)
      .filter((event) => !input.since || event.at > input.since);
  }

  async comment(input: { repo: string; number: number; body: string }): Promise<"sent" | "gone"> {
    try {
      await this.run([
        "api",
        "--method",
        "POST",
        `repos/${input.repo}/issues/${input.number}/comments`,
        "-f",
        `body=${input.body}`,
      ]);
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(404|410)\b|not found|gone/i.test(message)) return "gone";
      throw error;
    }
  }
}
