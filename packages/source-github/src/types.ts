export type GitHubEventKind = "issue" | "pull_request" | "comment" | "review" | "ci";

/** One normalized repository event. */
export interface GitHubEvent {
  id: string;
  at: string;
  kind: GitHubEventKind;
  repo: string;
  number?: number;
  branch?: string;
  actor: string;
  bot: boolean;
  body: string;
  title?: string;
  url?: string;
  status?: string;
}

export interface GitHubApi {
  events(input: { repo: string; since?: string }): Promise<GitHubEvent[]>;
  comment(input: { repo: string; number: number; body: string }): Promise<"sent" | "gone">;
}
