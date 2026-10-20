import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { type Skill, type SkillDraft, type SkillRepository, validateSkill } from "@mentat/skills";

/** Atomic snapshots and optimistic per-skill versions; lock contention fails without replay. */
export class FileSkillRepository implements SkillRepository {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private snapshot(): Skill[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    if (data.schemaVersion !== 1 || !Array.isArray(data.entries))
      throw new Error("invalid skill repository");
    const keys = new Set<string>();
    for (const skill of data.entries) {
      validateSkill(skill);
      if (
        skill.origin !== "agent-procedure" ||
        !Number.isSafeInteger(skill.version) ||
        skill.version < 1 ||
        !Number.isFinite(skill.createdAt) ||
        !Number.isFinite(skill.updatedAt)
      )
        throw new Error("invalid skill metadata");
      const key = JSON.stringify([skill.scope, skill.name]);
      if (keys.has(key)) throw new Error("duplicate skill identity");
      keys.add(key);
    }
    return data.entries;
  }
  list(scope?: string): Skill[] {
    return this.snapshot().filter((s) => s.scope === scope);
  }
  get(name: string, scope?: string): Skill | undefined {
    return this.list(scope).find((s) => s.name === name);
  }
  save(draft: SkillDraft, expectedVersion: number): Skill {
    validateSkill(draft);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new Error("invalid expected skill version");
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    mkdirSync(lock); // No implicit retry or stale-lock stealing.
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const entries = this.snapshot();
      const index = entries.findIndex((s) => s.name === draft.name && s.scope === draft.scope);
      const previous = entries[index];
      if ((previous?.version ?? 0) !== expectedVersion)
        throw new Error("skill version conflict; read current version before updating");
      const now = Date.now();
      const skill: Skill = {
        ...draft,
        version: expectedVersion + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        origin: "agent-procedure",
      };
      if (index < 0) entries.push(skill);
      else entries[index] = skill;
      writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, entries })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, this.path);
      return skill;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      rmdirSync(lock);
    }
  }
}
