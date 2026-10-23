import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskAcceptance } from "@mentat/core";
import { isWithin, prepareFilePolicy, prepareOutputContract } from "@mentat/evaluation";
import type { ResultEvaluator } from "@mentat/host";

/** CLI wiring only: file auditing/schema validation live in evaluation. */
export function prepareRunContract(cwd: string, policyFile?: string, contractFile?: string) {
  const root = realpathSync(cwd);
  const readConfig = (file: string) => {
    const path = realpathSync(resolve(file));
    if (isWithin(root, path))
      throw new Error("worker policy and output contract must live outside the task directory");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const guard = policyFile ? prepareFilePolicy(root, readConfig(policyFile)) : undefined;
  const control = mkdtempSync(join(tmpdir(), "mentat-run-control-"));
  if (isWithin(root, realpathSync(control)))
    throw new Error("worker control must live outside task directory");
  const outputSpec = contractFile ? readConfig(contractFile) : undefined;
  const contract = outputSpec ? prepareOutputContract(root, outputSpec, control) : undefined;
  if (
    guard &&
    contract &&
    !guard.policy.writeFiles.some((name) => resolve(root, name) === contract.output)
  )
    throw new Error("contract output must be in execution policy writeFiles");
  writeFileSync(
    join(control, "contract.json"),
    JSON.stringify(
      {
        root,
        policy: guard?.policy ?? null,
        policyFingerprint: guard?.fingerprint ?? null,
        outputContractFingerprint: contract?.fingerprint ?? null,
        outputContract: outputSpec ?? null,
        before: guard?.before ?? null,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o400 },
  );
  const resultEvaluator: ResultEvaluator = {
    id: "file-output-contract-v1",
    timeoutMs: 125000,
    async evaluate({ signal }) {
      const audits: unknown[] = [];
      const audit = () => {
        if (!guard) return [];
        const result = guard.audit();
        audits.push(result);
        return result.issues;
      };
      let decision: Omit<TaskAcceptance, "evaluator">;
      try {
        const issues = audit();
        if (issues.length) decision = { status: "rejected", issues };
        else if (contract) decision = await contract.evaluate(signal);
        else
          decision = {
            status: "not-evaluated",
            issues: [],
          };
        const afterIssues = audit();
        if (afterIssues.length)
          decision = {
            ...decision,
            status: "rejected",
            issues: [...new Set([...decision.issues, ...afterIssues])],
          };
      } catch (error) {
        decision = { status: "error", issues: [String(error)] };
      }
      const report = { ...decision, policyFingerprint: guard?.fingerprint ?? null, audits };
      const reportFile = join(control, `acceptance-${crypto.randomUUID()}.json`);
      writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      return {
        ...decision,
        evidence: {
          ...(typeof decision.evidence === "object" &&
          decision.evidence !== null &&
          !Array.isArray(decision.evidence)
            ? decision.evidence
            : {}),
          auditFile: reportFile,
          policyFingerprint: guard?.fingerprint ?? null,
        },
      };
    },
  };
  return {
    root,
    control,
    guard,
    resultEvaluator,
    policy: guard?.policy,
    hasAcceptanceContract: Boolean(contract),
  };
}
