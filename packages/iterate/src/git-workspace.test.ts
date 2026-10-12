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
  it("commits a change, reports changed files, and rolls back", async () => {
    const dir = makeRepo();
    const workspace = new GitWorkspace(dir);
    const root = workspace.current();

    writeFileSync(join(dir, "a.txt"), "two\n");
    const child = await workspace.apply({ id: "c1", description: "change a" });
    expect(child.id).not.toBe(root.id);
    expect(workspace.changedFiles(child)).toContain("a.txt");

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
