import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOpenCodeAdapter } from "./opencode";
import { opencodeFilePolicy } from "./opencode-policy";

it("overrides inherited permissive agent rules with an exact default-deny file policy", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mentat-native-policy-")));
  const capture = join(root, "capture.json"),
    fixture = join(root, "wire.mjs");
  writeFileSync(join(root, "input.txt"), "source");
  writeFileSync(
    fixture,
    `import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='session/new')writeFileSync(process.env.CAPTURE,process.env.OPENCODE_CONFIG_CONTENT);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:{sessionId:'test'}})+'\\n')});`,
  );
  const policy = {
    kind: "file-allowlist" as const,
    readFiles: ["input.txt"],
    writeFiles: ["result.json"],
  };
  const adapter = createOpenCodeAdapter({
    binary: process.execPath,
    baseArgs: [fixture],
    startupSettleMs: 0,
    env: {
      CAPTURE: capture,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        default_agent: "worker",
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        agents: {
          worker: { permissions: [{ action: "*", resource: "*", effect: "allow" }], steps: 10 },
        },
      }),
    },
  });
  const session = await adapter.createSession({ cwd: root, executionPolicy: policy });
  try {
    const config = JSON.parse(readFileSync(capture, "utf8"));
    const expected = opencodeFilePolicy(root, policy);
    expect(config.permissions).toEqual(expected);
    expect(config.agents.worker.permissions).toEqual(expected);
    expect(config.agents.worker.steps).toBe(10);
    expect(
      expected
        .filter((rule) => rule.effect === "allow")
        .every((rule) => ["read", "edit"].includes(rule.action)),
    ).toBe(true);
  } finally {
    await session.dispose();
  }
});

it("replaces the native agent system prompt while preserving tool and permission configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-opencode-config-"));
  const capture = join(root, "capture.json");
  const fixture = join(root, "wire.mjs");
  writeFileSync(
    fixture,
    `import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='session/new')writeFileSync(process.env.CAPTURE,process.env.OPENCODE_CONFIG_CONTENT);const result=m.method==='initialize'?{protocolVersion:1}:{sessionId:'test'};if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
  );
  const permissions = [{ action: "*", resource: "*", effect: "deny" }];
  const mcp = { servers: { task: { type: "local", command: ["fixture"] } } };
  const adapter = createOpenCodeAdapter({
    binary: process.execPath,
    baseArgs: [fixture],
    env: {
      CAPTURE: capture,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        default_agent: "worker",
        agents: { worker: { steps: 12, system: "old" }, title: { system: "title" } },
        permissions,
        mcp,
      }),
    },
  });
  expect(adapter.capabilities().systemPrompt).toBe("replace");
  const session = await adapter.createSession({
    cwd: root,
    systemPrompt: "host policy",
    systemPromptMode: "replace",
  });
  try {
    const config = JSON.parse(readFileSync(capture, "utf8"));
    expect(config).toMatchObject({
      default_agent: "worker",
      agents: { worker: { steps: 12, system: "host policy" }, title: { system: "title" } },
      permissions,
      mcp,
    });
  } finally {
    await session.dispose();
  }
});
