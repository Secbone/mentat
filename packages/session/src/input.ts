/** Host-owned source labels; never accept a model's claim about its own provenance. */
export type EvidenceOrigin =
  | "user"
  | "host-policy"
  | "quoted-material"
  | "assistant"
  | "tool"
  | "legacy";
export type EvidenceMemoryScope = "task" | "reusable" | "unspecified";

export interface EvidenceFragment {
  origin: EvidenceOrigin;
  text: string;
  attribution?: string;
  memoryScope?: EvidenceMemoryScope;
}

/** Structured host input. Materials remain quoted even when attributed to the user. */
export interface TaskInput {
  text: string;
  /** Host assertion of explicit reuse intent; absence is not permission to generalize. */
  memoryScope?: EvidenceMemoryScope;
  hostPolicy?: string;
  materials?: Array<{ text: string; attribution?: string; memoryScope?: EvidenceMemoryScope }>;
}

export function normalizeTaskInput(input: string | TaskInput): TaskInput {
  if (typeof input === "string") return { text: input };
  if (!input || typeof input.text !== "string") throw new TypeError("task text must be a string");
  const validScope = (scope: unknown) =>
    scope === undefined ||
    (typeof scope === "string" && ["task", "reusable", "unspecified"].includes(scope));
  if (!validScope(input.memoryScope)) throw new TypeError("invalid input memory scope");
  if (input.hostPolicy !== undefined && typeof input.hostPolicy !== "string")
    throw new TypeError("host policy must be a string");
  if (input.materials !== undefined && !Array.isArray(input.materials))
    throw new TypeError("materials must be an array");
  const materials = input.materials?.map((material) => {
    if (
      !material ||
      typeof material.text !== "string" ||
      (material.attribution !== undefined && typeof material.attribution !== "string") ||
      !validScope(material.memoryScope)
    )
      throw new TypeError("material requires text and optional attribution");
    return {
      text: material.text,
      ...(material.attribution !== undefined ? { attribution: material.attribution } : {}),
      ...(material.memoryScope !== undefined ? { memoryScope: material.memoryScope } : {}),
    };
  });
  return {
    text: input.text,
    ...(input.memoryScope !== undefined ? { memoryScope: input.memoryScope } : {}),
    ...(input.hostPolicy !== undefined ? { hostPolicy: input.hostPolicy } : {}),
    ...(materials ? { materials } : {}),
  };
}

export function inputFragments(input: TaskInput): EvidenceFragment[] {
  input = normalizeTaskInput(input);
  return [
    {
      origin: "user",
      text: input.text,
      ...(input.memoryScope !== undefined ? { memoryScope: input.memoryScope } : {}),
    },
    ...(input.hostPolicy !== undefined
      ? [{ origin: "host-policy" as const, text: input.hostPolicy }]
      : []),
    ...(input.materials?.map((material) => ({ origin: "quoted-material" as const, ...material })) ??
      []),
  ];
}
