/** A transport may finish while returning an unexecuted protocol block, not an answer.
 * Opt in for answer-only tasks; code/documentation tasks can legitimately quote protocols.
 * This never parses or executes model-generated calls.
 */
export type FinalAnswerIssue = "empty-answer" | "tool-protocol-text";

export function finalAnswerIssue(text: string): FinalAnswerIssue | undefined {
  if (!text.trim()) return "empty-answer";
  if (/<[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*(?:calls|invoke|parameter)\b/i.test(text))
    return "tool-protocol-text";
  return undefined;
}

/**
 * Host-owned instruction for a single corrective re-ask after an invalid final
 * answer. It states the observed defect and the required output shape without
 * echoing model output back as instructions.
 */
export function correctiveInstruction(issue: FinalAnswerIssue): string {
  const base =
    "Your previous response did not contain a final answer. Reply with the final answer as plain text only. Do not print tool calls or protocol syntax.";
  return issue === "empty-answer"
    ? `Your previous response was empty. ${base} If the evidence is insufficient, state explicitly what is unknown.`
    : `${base} If the evidence is insufficient, state explicitly what is unknown rather than inventing facts, and do not claim a lookup succeeded without a result.`;
}
