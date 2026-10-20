import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "@mentat/core";
export function skillsMcpSpec(path: string, scope?: string): McpServerSpec {
  return {
    name: "procedures",
    catalogTools: ["skills_list", "skill_view", "skill_save"],
    command: process.execPath,
    args: [fileURLToPath(new URL("./loader.mjs", import.meta.url))],
    env: { MENTAT_SKILLS_FILE: path, ...(scope ? { MENTAT_SKILLS_SCOPE: scope } : {}) },
  };
}
