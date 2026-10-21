import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContainerRunner, dockerRunArgs } from "./container";

describe("dockerRunArgs", () => {
  it("reclaims an owned container after the Docker client times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-container-cleanup-")),
      docker = join(dir, "docker"),
      receipt = join(dir, "cleanup.json");
    writeFileSync(
      docker,
      `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='run'){fs.writeFileSync(a[a.indexOf('--cidfile')+1],'a'.repeat(64));setInterval(()=>{},1000)}
else {fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(a));}
`,
    );
    chmodSync(docker, 0o700);
    const result = await new ContainerRunner(docker).run({
      cwd: dir,
      image: "fake",
      command: ["task"],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([
      "rm",
      "--force",
      expect.stringMatching(/^mentat-/),
    ]);
  });
  it("mounts the workspace and disables the network by default", () => {
    const args = dockerRunArgs({
      image: "alpine:3",
      command: ["sh", "-c", "echo hi"],
      cwd: "/host/proj",
    });
    expect(args.slice(0, 6)).toEqual([
      "run",
      "--rm",
      "-v",
      "/host/proj:/workspace",
      "-w",
      "/workspace",
    ]);
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args.slice(-4)).toEqual(["alpine:3", "sh", "-c", "echo hi"]);
  });

  it("includes env vars and a custom network", () => {
    const args = dockerRunArgs({
      image: "img",
      command: ["x"],
      cwd: "/h",
      network: "bridge",
      env: { A: "1" },
    });
    expect(args).toContain("bridge");
    expect(args.join(" ")).toContain("-e A=1");
  });
});

const dockerDescribe = process.env.MENTAT_DOCKER === "1" ? describe : describe.skip;

dockerDescribe("ContainerRunner (docker)", () => {
  it("runs a trivial command in an isolated container", async () => {
    const runner = new ContainerRunner();
    const result = await runner.run({
      image: "alpine:3",
      command: ["sh", "-c", "echo container-ok"],
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("container-ok");
  }, 120_000);
});
