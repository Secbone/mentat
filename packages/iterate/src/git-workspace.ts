import { execFileSync } from "node:child_process";
import type { Candidate, Proposal, Workspace } from "@mentat/core";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitWorkspaceOptions {
  identity?: GitIdentity;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
}

/**
 * A {@link Workspace} backed by a git repository. The agent edits files
 * directly (during proposal); `apply` commits the working tree as a candidate,
 * `rollback` hard-resets to the parent, `commit` keeps the accepted commit.
 */
export class GitWorkspace implements Workspace {
  private readonly cwd: string;
  private readonly identity: GitIdentity;
  private readonly parents = new Map<string, string>();
  private head: string;

  constructor(cwd: string, options: GitWorkspaceOptions = {}) {
    this.cwd = cwd;
    this.identity = options.identity ?? { name: "mentat", email: "mentat@localhost" };
    this.head = git(cwd, ["rev-parse", "HEAD"]);
  }

  current(): Candidate {
    return { id: this.head, version: this.head, artifacts: [] };
  }

  async apply(proposal: Proposal): Promise<Candidate> {
    git(this.cwd, ["add", "-A"]);
    if (git(this.cwd, ["status", "--porcelain"]).length === 0) {
      throw new Error("no changes to apply");
    }
    git(this.cwd, [
      "-c",
      `user.name=${this.identity.name}`,
      "-c",
      `user.email=${this.identity.email}`,
      "commit",
      "--no-verify",
      "-m",
      proposal.description || proposal.id,
    ]);
    const sha = git(this.cwd, ["rev-parse", "HEAD"]);
    this.parents.set(sha, this.head);
    this.head = sha;
    return { id: sha, version: sha, artifacts: [] };
  }

  async commit(child: Candidate): Promise<void> {
    this.parents.delete(child.id);
  }

  async rollback(child: Candidate): Promise<void> {
    const parent = this.parents.get(child.id);
    if (!parent) return;
    git(this.cwd, ["reset", "--hard", parent]);
    git(this.cwd, ["clean", "-fd"]);
    this.parents.delete(child.id);
    this.head = parent;
  }

  /** Repo-relative files changed by a candidate relative to its parent commit. */
  changedFiles(candidate: Candidate): string[] {
    const parent = this.parents.get(candidate.id);
    if (!parent) return [];
    const out = git(this.cwd, ["diff", "--name-only", parent, candidate.id]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}
