import type { SourceKind, SourceState, Trigger } from "@mentat/domain";
import type { OutboxMessage, OutboxTransport } from "@mentat/effects";
import type { GitHubApi, GitHubEvent } from "./types";

export interface GitHubSourceOptions {
  api: GitHubApi;
  state: SourceState;
  /** owner/name */
  repo: string;
  /** Agent account login, used to detect an @mention. */
  agentLogin: string;
  id?: string;
  /** How many event ids to remember for deduplication. */
  seenLimit?: number;
}

export class GitHubChannel implements OutboxTransport {
  constructor(
    private readonly api: GitHubApi,
    private readonly repo: string,
  ) {}

  async send(message: OutboxMessage): Promise<"sent" | "gone"> {
    const match = /^github:([^#]+)#(\d+)$/.exec(message.channel);
    if (!match) return "gone";
    const repo = match[1];
    const number = Number(match[2]);
    if (repo !== this.repo || !Number.isSafeInteger(number) || number <= 0) return "gone";
    return this.api.comment({ repo, number, body: message.text });
  }
}

/**
 * GitHub repository events as a Source. The read position is the latest
 * `created_at` plus a bounded set of seen ids, so a restart does not replay.
 */
export class GitHubSource implements SourceKind {
  readonly id: string;
  readonly label: string;
  private readonly api: GitHubApi;
  private readonly state: SourceState;
  private readonly repo: string;
  private readonly agentLogin: string;
  private readonly seenLimit: number;

  constructor(options: GitHubSourceOptions) {
    this.api = options.api;
    this.state = options.state;
    this.repo = options.repo;
    this.agentLogin = options.agentLogin;
    this.id = options.id ?? `github:${options.repo}`;
    this.label = `GitHub ${options.repo}`;
    this.seenLimit = options.seenLimit ?? 500;
  }

  channel(): GitHubChannel {
    return new GitHubChannel(this.api, this.repo);
  }

  async poll(): Promise<Trigger[]> {
    const since = this.state.get<string>("since");
    const seen = new Set(this.state.get<string[]>("seen") ?? []);
    const events = (await this.api.events({ repo: this.repo, since }))
      .filter((event) => !seen.has(event.id))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (events.length === 0) return [];
    for (const event of events) seen.add(event.id);
    this.state.set("seen", [...seen].slice(-this.seenLimit));
    this.state.set("since", events[events.length - 1]?.at ?? since ?? "");
    return events.map((event) => this.toTrigger(event));
  }

  private toTrigger(event: GitHubEvent): Trigger {
    const number = event.number;
    const thread = number
      ? `github:${this.repo}#${number}`
      : `github:${this.repo}:ci:${event.branch ?? "default"}`;
    const channel = number ? `github:${this.repo}#${number}` : undefined;
    const text = (event.body || event.title || `${event.kind} ${event.status ?? ""}`).trim();
    return {
      id: `github:${event.id}`,
      source: this.id,
      thread,
      actor: event.actor,
      bot: event.bot || event.actor.endsWith("[bot]"),
      addressed: text.includes(`@${this.agentLogin}`) ? "mention" : "none",
      text,
      at: event.at,
      meta: {
        scope: event.kind,
        ...(channel ? { channel } : {}),
        ...(event.url ? { url: event.url } : {}),
      },
    };
  }
}
