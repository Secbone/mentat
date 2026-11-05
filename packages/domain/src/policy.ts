import type {
  AdmissionCell,
  AdmissionRow,
  Mandate,
  MandateBasis,
  Policy,
  Strength,
  TriggerFacts,
} from "./types";

export interface GateDecision {
  strength: Strength;
  basis: MandateBasis;
}

const RANK: Record<Strength, number> = {
  not_admitted: 0,
  inferred: 1,
  explicit: 2,
};

function notAdmitted(facts: TriggerFacts, via: MandateBasis["via"]): GateDecision {
  return {
    strength: "not_admitted",
    basis: {
      via,
      source: facts.source,
      sender: facts.sender,
      scope: facts.scope,
    },
  };
}

function cellFor(policy: Policy, facts: TriggerFacts, listed: boolean): AdmissionCell {
  const source = policy.sources[facts.source];
  if (!source) return "ignore";
  if (listed) return facts.addressed === "none" ? source.admission.listedUnaddressed : "explicit";
  return facts.addressed === "none"
    ? source.admission.unlistedUnaddressed
    : source.admission.unlistedAddressed;
}

/**
 * The deterministic first layer of Eval. It decides whether a Trigger may
 * originate work and with what strength; the model assessment comes later.
 */
export function gate(policy: Policy, facts: TriggerFacts): GateDecision {
  const source = policy.sources[facts.source];
  if (!source) return notAdmitted(facts, "admission");

  if (facts.bot) {
    if (!source.bots.includes(facts.sender)) return notAdmitted(facts, "bot");
    if (policy.acceptMode === "off") return notAdmitted(facts, "bot");
    return {
      strength: "inferred",
      basis: { via: "bot", source: facts.source, sender: facts.sender },
    };
  }

  const listed = source.allowed.includes(facts.sender);

  if (listed && facts.addressed !== "none")
    return {
      strength: "explicit",
      basis: { via: "addressed", source: facts.source, sender: facts.sender, scope: facts.scope },
    };

  if (facts.followup) {
    if (listed)
      return {
        strength: "explicit",
        basis: { via: "followup", source: facts.source, sender: facts.sender, scope: facts.scope },
      };
    if (source.admission.unlistedAddressed === "explicit")
      return {
        strength: "explicit",
        basis: { via: "followup", source: facts.source, sender: facts.sender, scope: facts.scope },
      };
    return policy.acceptMode === "off"
      ? notAdmitted(facts, "followup")
      : {
          strength: "inferred",
          basis: {
            via: "followup",
            source: facts.source,
            sender: facts.sender,
            scope: facts.scope,
          },
        };
  }

  const cell = cellFor(policy, facts, listed);
  if (cell === "ignore") return notAdmitted(facts, "admission");
  if (cell === "explicit")
    return {
      strength: "explicit",
      basis: { via: "admission", source: facts.source, sender: facts.sender, scope: facts.scope },
    };
  if (policy.acceptMode === "off") return notAdmitted(facts, "admission");
  return {
    strength: "inferred",
    basis: { via: "admission", source: facts.source, sender: facts.sender, scope: facts.scope },
  };
}

function rulesStillEnabled(policy: Policy, ids: readonly string[]): boolean {
  return ids.every((id) => policy.rules.some((rule) => rule.id === id && rule.enabled));
}

/**
 * Re-check a Mandate before an ended Ticket resumes. A Policy change does not
 * revoke a live Mandate; it only affects revalidation and future Evals.
 */
export function revalidate(
  policy: Policy,
  mandate: Mandate,
  facts: TriggerFacts,
  options: { sourceListens: boolean },
): boolean {
  if (mandate.withdrawnAt || !options.sourceListens) return false;

  const source = policy.sources[mandate.basis.source];
  if (!source) return false;

  // Explicit follow-ups pass without a fresh gate decision.
  if (mandate.strength === "explicit" && mandate.basis.via === "followup") return true;

  const current = gate(policy, facts);
  if (current.strength === "not_admitted") return false;

  if (mandate.basis.via === "bot") {
    return (
      source.bots.includes(mandate.basis.sender) &&
      policy.acceptMode === "auto" &&
      rulesStillEnabled(policy, mandate.matchedRules)
    );
  }

  if (mandate.strength === "inferred") {
    return policy.acceptMode === "auto" && rulesStillEnabled(policy, mandate.matchedRules);
  }

  // Explicit Mandates: the sender must still be allowed, and the current gate
  // must still reach at least the original strength.
  if (!source.allowed.includes(mandate.basis.sender)) return false;
  return RANK[current.strength] >= RANK[mandate.strength];
}

/** Whether inferred work may be accepted under this Policy. */
export function acceptsInferred(policy: Policy): boolean {
  return policy.acceptMode === "auto";
}

/** A fresh admission row with the Super-agent defaults. */
export function defaultAdmissionRow(): AdmissionRow {
  return {
    listedUnaddressed: "inferred",
    unlistedAddressed: "ignore",
    unlistedUnaddressed: "ignore",
  };
}
