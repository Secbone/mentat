/** A transport may finish while returning an unexecuted protocol block, not an answer.
 * Opt in for answer-only tasks; code/documentation tasks can legitimately quote protocols.
 * This never parses or executes model-generated calls.
 */
export function finalAnswerIssue(text: string): "empty-answer" | "tool-protocol-text" | undefined {
  if (!text.trim()) return "empty-answer";
  if (/<[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*(?:calls|invoke|parameter)\b/i.test(text))
    return "tool-protocol-text";
  return undefined;
}
