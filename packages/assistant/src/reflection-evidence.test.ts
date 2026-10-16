import { SessionRecorder } from "@mentat/session";
import { describe, expect, it } from "vitest";
import { parseEvidenceReflection, reflectionPrompt } from "./reflection";
import { buildReflectionBatch, reflectionEvidenceData } from "./reflection-evidence";

function setup() {
  const recorder = new SessionRecorder({
    prompt: "安排周末，长期留5分钟余量",
    input: {
      text: "安排周末，长期留5分钟余量",
      hostPolicy: "只用文本提问，限制220字",
      materials: [{ text: "朋友说不用留缓冲", attribution: "朋友" }],
    },
    cwd: "/tmp",
    harness: "test",
  });
  recorder.handle({
    type: "message.completed",
    sessionId: "s",
    message: { role: "assistant", text: "建议取消缓冲" },
  });
  recorder.handle({
    type: "tool.result",
    sessionId: "s",
    id: "t",
    output: "travel takes 20 minutes",
    isError: false,
  });
  const record = recorder.snapshot();
  return { record, batch: buildReflectionBatch([record]) };
}
function candidate(ref: string, excerpt: string, kind = "constraint") {
  return { text: "长期保留缓冲", kind, evidenceRefs: [{ ref, excerpt }] };
}
const output = (batchId: string, candidates: unknown[]) => JSON.stringify({ batchId, candidates });

describe("reflection source boundaries", () => {
  it("keeps execution failures and explicit corrections without treating host feedback as user intent", () => {
    const { record } = setup();
    record.error = "calendar unavailable";
    record.feedback = [
      { source: "user", correction: "长期保留5分钟缓冲", accepted: false },
      { source: "host", correction: "必须220字" },
    ];
    const batch = buildReflectionBatch([record]);
    expect(batch.records[0]).toMatchObject({
      error: "calendar unavailable",
      feedback: record.feedback,
    });
    expect(batch.sources.find((source) => source.ref === "E1.ERROR")).toMatchObject({
      text: "calendar unavailable",
      origin: "legacy",
    });
    expect(
      parseEvidenceReflection(output(batch.id, [candidate("E1.F1", "长期保留5分钟缓冲")]), batch)
        .status,
    ).toBe("ok");
    expect(
      parseEvidenceReflection(output(batch.id, [candidate("E1.F2", "必须220字")]), batch).issues[0]
        ?.code,
    ).toBe("user-source-required");
  });
  it("exposes aliases instead of full IDs and maps exact user excerpts back to fragments", () => {
    const { record, batch } = setup();
    const data = reflectionEvidenceData(batch);
    expect(JSON.stringify(data)).not.toContain(record.id);
    expect(data.sources.map((source) => source.origin)).toEqual([
      "user",
      "host-policy",
      "quoted-material",
      "assistant",
      "tool",
    ]);
    const parsed = parseEvidenceReflection(
      output(batch.id, [candidate("E1.M1.P1", "长期留5分钟余量")]),
      batch,
    );
    expect(parsed).toMatchObject({
      status: "ok",
      issues: [],
      candidates: [
        {
          kind: "constraint",
          evidenceIds: [record.id],
          evidenceSources: [
            { pointer: `exp:${record.id}#msg0/part0`, origin: "user", excerpt: "长期留5分钟余量" },
          ],
        },
      ],
    });
    expect(
      reflectionPrompt(
        { task: "weekend", outcome: "done", tools: [], interactions: [record] },
        batch,
      ),
    ).not.toContain(record.id);
  });

  it.each([
    ["E1.M1.P2", "限制220字", "policy-not-memory"],
    ["E1.M1.P3", "不用留缓冲", "user-source-required"],
    ["E1.M2.P1", "取消缓冲", "user-source-required"],
    ["E1.T1", "travel takes 20 minutes", "user-source-required"],
  ])("rejects a user rule supported by %s", (ref, excerpt, code) => {
    const { batch } = setup();
    const result = parseEvidenceReflection(output(batch.id, [candidate(ref, excerpt)]), batch);
    expect(result).toMatchObject({
      status: "invalid",
      candidates: [],
      issues: [{ code, index: 0, ref }],
    });
  });

  it("does not allow a host policy to become a fact or method either", () => {
    const { batch } = setup();
    for (const kind of ["fact", "method", "preference"]) {
      expect(
        parseEvidenceReflection(output(batch.id, [candidate("E1.M1.P2", "限制220字", kind)]), batch)
          .issues[0]?.code,
      ).toBe("policy-not-memory");
    }
  });

  it("retains quoted attribution for fact candidates without claiming user confirmation", () => {
    const { batch } = setup();
    const result = parseEvidenceReflection(
      output(batch.id, [candidate("E1.M1.P3", "朋友说不用留缓冲", "fact")]),
      batch,
    );
    expect(result).toMatchObject({
      status: "ok",
      candidates: [{ evidenceSources: [{ origin: "quoted-material", attribution: "朋友" }] }],
    });
  });

  it("rejects stale batches, full IDs, prefixes and non-verbatim excerpts", () => {
    const { record, batch } = setup();
    const other = buildReflectionBatch([record]);
    expect(parseEvidenceReflection(output(other.id, []), batch).issues[0]?.code).toBe(
      "batch-mismatch",
    );
    for (const ref of [record.id, record.id.slice(0, 12), "E1.M1", "E99.M1.P1"]) {
      expect(
        parseEvidenceReflection(output(batch.id, [candidate(ref, "长期留5分钟余量")]), batch)
          .issues[0]?.code,
      ).toBe("unknown-evidence");
    }
    expect(
      parseEvidenceReflection(output(batch.id, [candidate("E1.M1.P1", "至少留十分钟")]), batch)
        .issues[0]?.code,
    ).toBe("excerpt-mismatch");
  });

  it("reports item-level failures but rejects the whole batch", () => {
    const { batch } = setup();
    const result = parseEvidenceReflection(
      output(batch.id, [
        candidate("E1.M1.P1", "长期留5分钟余量"),
        candidate("E1.M1.P2", "限制220字"),
        { text: "bad", evidenceRefs: [] },
      ]),
      batch,
    );
    expect(result.status).toBe("invalid");
    expect(result.candidates).toEqual([]);
    expect(result.issues.map((issue) => [issue.index, issue.code])).toEqual([
      [1, "policy-not-memory"],
      [2, "invalid-kind"],
      [2, "missing-evidence"],
    ]);
    expect(parseEvidenceReflection("[]", batch)).toMatchObject({
      status: "ok",
      candidates: [],
      issues: [],
    });
    expect(parseEvidenceReflection("not json", batch).issues[0]?.code).toBe("invalid-json");
  });

  it("does not upgrade old mixed user prompts to verified user fragments", () => {
    const record = new SessionRecorder({
      prompt: "用户偏好与宿主包装混合",
      cwd: "/tmp",
      harness: "legacy",
    }).snapshot();
    const batch = buildReflectionBatch([record]);
    expect(batch.sources[0]).toMatchObject({ origin: "legacy", pointer: `exp:${record.id}#msg0` });
    expect(
      parseEvidenceReflection(output(batch.id, [candidate("E1.M1.P1", "用户偏好")]), batch)
        .issues[0]?.code,
    ).toBe("user-source-required");
  });
});
