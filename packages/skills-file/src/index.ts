import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Skill, type SkillDraft, type SkillRepository, validateSkill } from "@mentat/skills";
import { acquireFileLock, atomicJson } from "@mentat/storage-file";

/** Atomic snapshots and optimistic per-skill versions; lock contention fails without replay. */
export class FileSkillRepository implements SkillRepository {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private snapshot(path = this.path): Skill[] {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8"));
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
        !Number.isFinite(skill.updatedAt) ||
        (skill.status !== undefined && !["draft", "validated", "retired"].includes(skill.status))
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
    return this.write(draft, expectedVersion);
  }
  history(name: string, scope?: string): Skill[] {
    const versions = `${this.path}.versions`;
    const records = [
      ...this.snapshot(),
      ...(existsSync(versions)
        ? readdirSync(versions)
            .filter((file) => file.endsWith(".json"))
            .flatMap((file) => this.snapshot(join(versions, file)))
        : []),
    ];
    return [
      ...new Map(
        records
          .filter((skill) => skill.name === name && skill.scope === scope)
          .map((skill) => [skill.version, skill]),
      ).values(),
    ].sort((a, b) => a.version - b.version);
  }
  restore(
    name: string,
    scope: string | undefined,
    version: number,
    expectedVersion: number,
  ): Skill {
    const previous = this.history(name, scope).find((skill) => skill.version === version);
    if (!previous) throw new Error("skill version not found");
    return this.write(previous, expectedVersion);
  }
  review(
    name: string,
    scope: string | undefined,
    expectedVersion: number,
    review: { status: "validated" | "retired"; evaluation: NonNullable<Skill["evaluation"]> },
  ): Skill {
    const previous = this.get(name, scope);
    if (!previous) throw new Error("skill not found");
    if (
      !["validated", "retired"].includes(review.status) ||
      !review.evaluation.id?.trim() ||
      !Array.isArray(review.evaluation.evidence) ||
      !review.evaluation.evidence.length ||
      review.evaluation.evidence.some((value) => typeof value !== "string" || !value.trim()) ||
      (review.status === "validated" && review.evaluation.passed !== true)
    )
      throw new Error("skill publication requires passing evaluation evidence");
    return this.write(previous, expectedVersion, review);
  }
  private write(
    draft: SkillDraft,
    expectedVersion: number,
    review?: { status: "validated" | "retired"; evaluation: NonNullable<Skill["evaluation"]> },
  ): Skill {
    validateSkill(draft);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new Error("invalid expected skill version");
    mkdirSync(dirname(this.path), { recursive: true });
    const release = acquireFileLock(`${this.path}.lock`);
    try {
      const entries = this.snapshot();
      const index = entries.findIndex((s) => s.name === draft.name && s.scope === draft.scope);
      const previous = entries[index];
      if ((previous?.version ?? 0) !== expectedVersion)
        throw new Error("skill version conflict; read current version before updating");
      const now = Date.now();
      const skill: Skill = {
        name: draft.name,
        description: draft.description,
        applicability: draft.applicability,
        content: draft.content,
        evidence: draft.evidence,
        ...(draft.scope !== undefined ? { scope: draft.scope } : {}),
        version: expectedVersion + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        origin: "agent-procedure",
        status: review?.status ?? "draft",
        ...(review ? { evaluation: structuredClone(review.evaluation) } : {}),
      };
      if (index < 0) entries.push(skill);
      else entries[index] = skill;
      // Retain the immutable prior state before exposing a revision.
      const versions = `${this.path}.versions`;
      mkdirSync(versions, { recursive: true, mode: 0o700 });
      if (existsSync(this.path))
        atomicJson(
          join(versions, `${randomUUID()}.json`),
          JSON.parse(readFileSync(this.path, "utf8")),
        );
      atomicJson(this.path, { schemaVersion: 1, entries });
      return skill;
    } finally {
      release();
    }
  }
}
