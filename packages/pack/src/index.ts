import {
  type Digest,
  digestOf,
  type ExecutionPolicy,
  type JsonValue,
  type McpServerSpec,
} from "@mentat/core";

export interface SkillRef {
  name: string;
  version?: number;
  digest?: Digest;
}

export interface MemoryRef {
  /** Opaque snapshot id or path; the Memory plugin owns resolution. */
  snapshot?: string;
  digest?: Digest;
}

export interface CapabilityPackInput {
  id: string;
  version: number;
  prompt: {
    system?: string;
    teamSections?: Record<string, string>;
    role?: "router" | "worker";
  };
  skills?: SkillRef[];
  memory?: MemoryRef;
  tools?: {
    mcpServers?: McpServerSpec[];
    allowlist?: string[];
    blockedCommands?: string[];
    executionPolicy?: ExecutionPolicy;
  };
  policy?: {
    budget?: { wallMs?: number; steps?: number; costUsd?: number };
    permissions?: "read" | "write" | "sandbox";
    routing?: string;
  };
  model?: {
    provider?: string;
    model?: string;
    effort?: string;
  };
  evalProtocol?: {
    id: string;
    version: number;
    digest: Digest;
  };
}

export interface CapabilityPack extends CapabilityPackInput {
  /** Content address over the whole pack. */
  digest: Digest;
}

export interface PackRef {
  id: string;
  version: number;
  digest: Digest;
}

/** Freeze a pack and content-address every field that can change behavior. */
export function defineCapabilityPack(input: CapabilityPackInput): CapabilityPack {
  const normalized: CapabilityPackInput = { ...input, skills: input.skills ?? [] };
  const snapshot = JSON.parse(JSON.stringify(normalized)) as JsonValue;
  return { ...normalized, digest: digestOf(snapshot) };
}

export function packRef(pack: CapabilityPack): PackRef {
  return { id: pack.id, version: pack.version, digest: pack.digest };
}
