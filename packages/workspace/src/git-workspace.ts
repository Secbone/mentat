import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate, Proposal, Workspace } from "@mentat/evolution";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitWorkspaceOptions {
  identity?: GitIdentity;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * A {@link Workspace} backed by a git repository. The agent edits files
 * directly (during proposal); `apply` commits the working tree as a candidate,
 * `rollback` hard-resets to the parent, `commit` keeps the accepted commit.
 */
export class GitWorkspace implements Workspace {
  readonly cwd: string;
  private readonly identity: GitIdentity;
  private readonly parents = new Map<string, string>();
  private head: string;
  private proposing = false;
  private source?: { cwd: string; head: string; temp: string };

  /** A proposer only edits an owned detached worktree, never the caller's files. */
  static isolated(cwd: string): GitWorkspace {
    const source = new GitWorkspace(cwd);
    const temp = mkdtempSync(join(tmpdir(), "mentat-evolution-")),
      work = join(temp, "work");
    try {
      git(cwd, ["worktree", "add", "--detach", work, source.head]);
      const workspace = new GitWorkspace(work);
      workspace.source = { cwd, head: source.head, temp };
      return workspace;
    } catch (error) {
      try {
        git(cwd, ["worktree", "remove", "--force", work]);
      } catch {}
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }

  async publish(candidate: Candidate): Promise<void> {
    if (!this.source) return;
    const source = new GitWorkspace(this.source.cwd);
    if (source.head !== this.source.head)
      throw new Error("source HEAD changed; publication refused");
    if (candidate.id !== this.head)
      throw new Error("publication requires the active accepted candidate");
    git(this.source.cwd, ["merge", "--ff-only", candidate.id]);
  }

  async dispose(): Promise<void> {
    if (!this.source) return;
    const source = this.source;
    git(source.cwd, ["worktree", "remove", "--force", this.cwd]);
    rmSync(source.temp, { recursive: true, force: true });
    this.source = undefined;
  }

  constructor(cwd: string, options: GitWorkspaceOptions = {}) {
    this.cwd = cwd;
    this.identity = options.identity ?? { name: "mentat", email: "mentat@localhost" };
    this.head = git(cwd, ["rev-parse", "HEAD"]);
    this.assertClean();
  }

  private assertClean(): void {
    if (git(this.cwd, ["status", "--porcelain"]).length)
      throw new Error("evolution requires a clean worktree; existing changes were preserved");
  }

  async begin(): Promise<void> {
    this.assertClean();
    if (git(this.cwd, ["rev-parse", "HEAD"]) !== this.head)
      throw new Error("workspace HEAD changed outside the evolution transaction");
    this.proposing = true;
  }

  async abort(): Promise<void> {
    if (!this.proposing) return;
    git(this.cwd, ["reset", "--hard", this.head]);
    git(this.cwd, ["clean", "-fd"]);
    this.proposing = false;
  }

  async checkout(candidate: Candidate): Promise<void> {
    this.assertClean();
    git(this.cwd, ["reset", "--hard", candidate.id]);
    this.head = candidate.id;
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
    this.proposing = false;
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

  async inspect(candidate: Candidate) {
    return {
      candidateId: candidate.id,
      files: this.changedFiles(candidate),
      diff: this.diff(candidate),
    };
  }

  /** Unified diff of a candidate relative to its parent commit. */
  diff(candidate: Candidate): string {
    const parent = this.parents.get(candidate.id);
    if (!parent) return "";
    return this.diffShas(parent, candidate.id);
  }

  /** Unified diff between two commits. */
  diffShas(from: string, to: string): string {
    return git(this.cwd, ["diff", from, to]);
  }
}
