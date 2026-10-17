import type { RememberInput } from "@mentat/assistant";

/** Human-declared splits of already visible confirmation text. No model classification or future rubric. */
const rules: Record<
  string,
  Array<{ text: string; kind: "preference" | "constraint"; key: string }>
> = {
  manager: [
    {
      text: "项目排期先写“结论”，再写“依据”，最后写“风险”",
      kind: "preference",
      key: "manager.format",
    },
    {
      text: "没有我明确同意，不改变前后依赖，也不自行缩短环节时长",
      kind: "constraint",
      key: "manager.dependencies",
    },
  ],
  finance: [
    {
      text: "管理层金额用万元，四舍五入保留1位；明细用元保留2位；用途不明先问",
      kind: "preference",
      key: "finance.presentation",
    },
    {
      text: "待付若已包含在已发生支出中，不得重复相加",
      kind: "constraint",
      key: "finance.no-double-counting",
    },
  ],
  teacher: [
    {
      text: "给家长的反馈先写“可观察事实”，再写“下一步”；给同行先讲“教学框架”，再给“课堂例子”",
      kind: "preference",
      key: "teacher.audience",
    },
    { text: "没有测评证据，不给学生贴能力标签", kind: "constraint", key: "teacher.evidence" },
  ],
  household: [
    { text: "生活安排先给“时间表”，再给“约束核对”", kind: "preference", key: "household.format" },
    {
      text: "“X点前”均指严格早于，并至少另留5分钟余量",
      kind: "constraint",
      key: "household.deadline",
    },
    { text: "不能自行压缩办事或交通时长", kind: "constraint", key: "household.duration" },
  ],
};
export function explicitRules(scenario: string, directive: string): RememberInput[] {
  const entries = rules[scenario];
  if (
    !entries?.length ||
    !directive.includes("请长期记住") ||
    entries.some((r) => !directive.includes(r.text))
  )
    throw new Error("explicit rule mapping does not match observed user directive");
  return entries.map((r) => ({ ...r }));
}
