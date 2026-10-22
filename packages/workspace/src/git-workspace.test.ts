import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorkspace } from "./git-workspace";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentat-git-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return dir;
}

describe("GitWorkspace", () => {
  it("isolates failed proposals and fast-forwards only the selected candidate", async () => {
    const dir = makeRepo(),
      workspace = GitWorkspace.isolated(dir);
    try {
      expect(workspace.cwd).not.toBe(dir);
      await workspace.begin();
      writeFileSync(join(workspace.cwd, "a.txt"), "accepted\n");
      const child = await workspace.apply({ id: "new", description: "improve" });
      await workspace.commit(child);
      expect(execFileSync("git", ["show", "HEAD:a.txt"], { cwd: dir, encoding: "utf8" })).toBe(
        "one\n",
      );
      await workspace.publish(child);
      expect(execFileSync("git", ["show", "HEAD:a.txt"], { cwd: dir, encoding: "utf8" })).toBe(
        "accepted\n",
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses publication when the original worktree changed during evaluation", async () => {
    const dir = makeRepo(),
      workspace = GitWorkspace.isolated(dir);
    try {
      writeFileSync(join(dir, "a.txt"), "user edits\n");
      await expect(workspace.publish(workspace.current())).rejects.toThrow("clean worktree");
      expect(execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" })).toContain("user edits");
    } finally {
      await workspace.dispose();
    }
  });
  it("preserves dirty user files and refuses to start an evolution transaction", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "user edits\n");
    expect(() => new GitWorkspace(dir)).toThrow("clean worktree");
    expect(execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" })).toContain("user edits");
  });

  it("aborts proposer edits before a candidate exists", async () => {
    const dir = makeRepo(),
      workspace = new GitWorkspace(dir);
    await workspace.begin();
    writeFileSync(join(dir, "a.txt"), "failed proposal\n");
    await workspace.abort();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });
  it("commits a change, reports changed files, and rolls back", async () => {
    const dir = makeRepo();
    const workspace = new GitWorkspace(dir);
    const root = workspace.current();

    writeFileSync(join(dir, "a.txt"), "two\n");
    const child = await workspace.apply({ id: "c1", description: "change a" });
    expect(child.id).not.toBe(root.id);
    expect(workspace.changedFiles(child)).toContain("a.txt");
    // Code iterations now carry a real artifact identity (the git commit).
    expect(child.artifacts[0]?.ref).toMatchObject({
      kind: "core",
      id: "workspace",
      form: "code",
      digest: `git:${child.id}`,
    });

    await workspace.rollback(child);
    expect(workspace.current().id).toBe(root.id);
    const content = execFileSync("git", ["show", "HEAD:a.txt"], { cwd: dir, encoding: "utf8" });
    expect(content).toBe("one\n");
  });

  it("throws when there is nothing to apply", async () => {
    const dir = makeRepo();
    const workspace = new GitWorkspace(dir);
    await expect(workspace.apply({ id: "c1", description: "noop" })).rejects.toThrow(/no changes/);
  });
});
