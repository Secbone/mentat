import type { HarnessAdapter } from "@mentat/core";
import { type AcpAdapterOptions, createAcpAdapter } from "@mentat/transport-acp";
import { prepareOpenCodeMcp } from "./opencode-mcp";
import { opencodeFilePolicy } from "./opencode-policy";

/** OpenCode-specific prompt and MCP configuration. The generic ACP adapter
 * remains engine-agnostic; native tools keep their original permission checks.
 */
export function createOpenCodeAdapter(options: Omit<AcpAdapterOptions, "id">): HarnessAdapter {
  options = { ...options, startupSettleMs: options.startupSettleMs ?? 1000 };
  const base = createAcpAdapter({ ...options, baseArgs: options.baseArgs ?? ["acp"] });
  return {
    id: "opencode",
    label: "OpenCode ACP",
    capabilities: () => ({
      ...base.capabilities(),
      systemPrompt: "replace",
      mcpToolNaming: "server-prefixed",
      executionPolicy: "file-allowlist",
    }),
    async createSession(sessionOptions, deps) {
      if (sessionOptions.executionPolicy && sessionOptions.mcpServers?.length)
        throw new Error("restricted execution cannot expose MCP servers");
      const rules = sessionOptions.executionPolicy
        ? opencodeFilePolicy(sessionOptions.cwd, sessionOptions.executionPolicy)
        : undefined;
      const replace =
        sessionOptions.systemPromptMode === "replace" && Boolean(sessionOptions.systemPrompt);
      const nativeMcp = prepareOpenCodeMcp(sessionOptions.mcpServers ?? []);
      try {
        if (!replace && !sessionOptions.mcpServers?.length && !rules)
          return await base.createSession(sessionOptions, deps);
        const raw = options.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
        const config = raw ? JSON.parse(raw) : {};
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new Error("OpenCode configuration must be an object");
        const agent = config.default_agent ?? "build";
        if (typeof agent !== "string" || !agent.trim())
          throw new Error("invalid OpenCode primary agent");
        const existing = options.startupReadiness
          ? Array.isArray(options.startupReadiness)
            ? options.startupReadiness
            : [options.startupReadiness]
          : [];
        const adapter = createAcpAdapter({
          ...options,
          baseArgs: options.baseArgs ?? ["acp"],
          startupReadiness: [...existing, ...nativeMcp.catalog],
          env: {
            ...options.env,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...config,
              ...(replace || rules
                ? {
                    default_agent: agent,
                    agents: {
                      ...config.agents,
                      [agent]: {
                        ...config.agents?.[agent],
                        ...(replace ? { system: sessionOptions.systemPrompt } : {}),
                        ...(rules ? { permissions: rules } : {}),
                      },
                    },
                  }
                : {}),
              ...(rules ? { permissions: rules } : {}),
              ...(sessionOptions.mcpServers?.length
                ? {
                    mcp: {
                      ...config.mcp,
                      servers: { ...config.mcp?.servers, ...nativeMcp.servers },
                    },
                  }
                : {}),
            }),
          },
        });
        const { mcpServers: _, executionPolicy: __policy, ...withoutMcp } = sessionOptions;
        const { systemPrompt: __, systemPromptMode: ___, ...withoutSystem } = withoutMcp;
        if (replace)
          deps?.onDiagnostic?.({
            code: "OPENCODE_SYSTEM_PROMPT_REPLACED",
            message: JSON.stringify({
              agent,
              delivery: "agent.system",
              characters: sessionOptions.systemPrompt?.length,
            }),
          });
        if (rules)
          deps?.onDiagnostic?.({
            code: "OPENCODE_FILE_POLICY_CONFIGURED",
            message: JSON.stringify({ rules, enforcement: "native-tools", isOsSandbox: false }),
          });
        if (sessionOptions.mcpServers?.length)
          deps?.onDiagnostic?.({
            code: "OPENCODE_DIRECT_MCP_CONFIGURED",
            message: JSON.stringify({
              servers: Object.keys(nativeMcp.servers),
              catalogReceipts: nativeMcp.catalog.length,
              permissionPolicy: "unchanged",
            }),
          });
        const session = await adapter.createSession(replace ? withoutSystem : withoutMcp, deps);
        return {
          id: session.id,
          send: session.send.bind(session),
          subscribe: session.subscribe.bind(session),
          interrupt: session.interrupt.bind(session),
          async dispose() {
            try {
              await session.dispose();
            } finally {
              nativeMcp.dispose();
            }
          },
        };
      } catch (error) {
        nativeMcp.dispose();
        throw error;
      }
    },
  };
}
