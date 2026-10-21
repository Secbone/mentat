/** Procedural knowledge, separate from confirmed user preferences and task data. */
export interface Skill {
  name: string;
  description: string;
  applicability: string;
  content: string;
  evidence: string;
  scope?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  origin: "agent-procedure";
  /** Agent saves are drafts; only host-owned evaluation can publish a revision. */
  status?: "draft" | "validated" | "retired";
  evaluation?: { id: string; passed: boolean; evidence: string[] };
}
export type SkillDraft = Pick<
  Skill,
  "name" | "description" | "applicability" | "content" | "evidence" | "scope"
>;
export interface SkillRepository {
  list(scope?: string): Skill[];
  get(name: string, scope?: string): Skill | undefined;
  save(draft: SkillDraft, expectedVersion: number): Skill;
  history(name: string, scope?: string): Skill[];
  restore(name: string, scope: string | undefined, version: number, expectedVersion: number): Skill;
  review(
    name: string,
    scope: string | undefined,
    expectedVersion: number,
    review: { status: "validated" | "retired"; evaluation: NonNullable<Skill["evaluation"]> },
  ): Skill;
}
export function validateSkill(draft: SkillDraft): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.name)) throw new Error("invalid skill name");
  for (const [key, max] of [
    ["description", 1024],
    ["applicability", 4000],
    ["content", 64000],
    ["evidence", 8000],
  ] as const) {
    const value = draft[key];
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error(`invalid skill ${key}`);
  }
  if (
    draft.scope !== undefined &&
    (typeof draft.scope !== "string" || !draft.scope.trim() || draft.scope.length > 256)
  )
    throw new Error("invalid skill scope");
}
export function rankSkills(skills: Skill[], query = "", limit = 10): Skill[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const score = (s: Skill) =>
    terms.reduce(
      (n, t) =>
        n + Number(`${s.name} ${s.description} ${s.applicability}`.toLowerCase().includes(t)),
      0,
    );
  return [...skills]
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, Math.min(50, limit)));
}
