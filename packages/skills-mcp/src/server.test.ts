import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSkillRepository } from "@mentat/skills-file";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { skillsMcpSpec } from "./index";

it("creates, finds, reads and updates real procedural artifacts through MCP", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-skills-mcp-")), "skills.json");
  const spec = skillsMcpSpec(path, "user-a");
  const client = new Client({ name: "contract", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...process.env, ...spec.env } as Record<string, string>,
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "skill_save",
      "skill_view",
      "skills_list",
    ]);
    const draft = {
      name: "triage",
      description: "Alert triage",
      applicability: "An alert contains observed severity evidence",
      content: "Inspect records, apply the documented rule, and verify the result.",
      evidence: "The current task exposed the rule and a confirmed correction.",
      expectedVersion: 0,
    };
    expect((await client.callTool({ name: "skill_save", arguments: draft })).isError).not.toBe(
      true,
    );
    const listed = await client.callTool({ name: "skills_list", arguments: { query: "alerts" } });
    expect(JSON.stringify(listed.content)).toContain("triage");
    expect(JSON.stringify(listed.content)).not.toContain(draft.content);
    const viewed = await client.callTool({ name: "skill_view", arguments: { name: "triage" } });
    expect(JSON.stringify(viewed.content)).toContain(draft.content);
    expect(
      (await client.callTool({ name: "skill_save", arguments: { ...draft, content: "stale" } }))
        .isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "skill_save",
          arguments: { ...draft, content: "Corrected workflow", expectedVersion: 1 },
        })
      ).isError,
    ).not.toBe(true);
    expect(new FileSkillRepository(path).get("triage", "user-a")).toMatchObject({
      version: 2,
      content: "Corrected workflow",
    });
    expect(new FileSkillRepository(path).list("user-b")).toEqual([]);
  } finally {
    await client.close();
  }
});
