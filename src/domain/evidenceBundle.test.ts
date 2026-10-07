import { describe, expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import {
  createEvidenceBundle,
  evidenceBundleForTarget,
  parseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
} from "./residualUnknown.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const targetDigest = "a".repeat(64);
const foreignDigest = "b".repeat(64);

const makeUnknown = (
  question: string,
  scopeDigest: string,
  dependency?: string,
) => {
  const input = recordUnknownInputSchema.parse({
    question,
    severity: "medium",
    domain: "bundle-projection",
    required_authority: null,
    required_confidence: "derived",
    required_environment: null,
    recommended_probes: [],
    relationships:
      dependency === undefined
        ? []
        : [{ type: "depends-on", unknown_id: dependency }],
  });
  const mutation = createEvidence(undefined, provider, {
    predicateType: "rea.residual-unknown-mutation",
    operation: "record_unknown",
    parameters: { domain: input.domain, severity: input.severity },
    result: {
      action: "record",
      question: input.question,
      required_authority: input.required_authority,
      required_confidence: input.required_confidence,
    },
  });
  return {
    evidence: mutation,
    unknown: createResidualUnknown(input, mutation.evidence_id, scopeDigest),
  };
};

describe("evidenceBundleForTarget", () => {
  it("removes dependent unknowns when their foreign-scope root is excluded", () => {
    const foreignRoot = makeUnknown("Foreign root", foreignDigest);
    const child = makeUnknown(
      "Target child",
      targetDigest,
      foreignRoot.unknown.unknown_id,
    );
    const grandchild = makeUnknown(
      "Target grandchild",
      targetDigest,
      child.unknown.unknown_id,
    );
    const retained = makeUnknown("Independent target", targetDigest);
    const bundle = createEvidenceBundle(
      [
        foreignRoot.evidence,
        child.evidence,
        grandchild.evidence,
        retained.evidence,
      ],
      [
        foreignRoot.unknown,
        child.unknown,
        grandchild.unknown,
        retained.unknown,
      ],
    );

    expect(evidenceBundleForTarget(bundle, targetDigest)).toEqual(
      createEvidenceBundle([retained.evidence], [retained.unknown]),
    );
  });

  it("projects a valid graph with more than 125,000 dependents", () => {
    const foreignRoot = makeUnknown("Foreign high-fan-out root", foreignDigest);
    const middle = makeUnknown(
      "Target middle depending on foreign root",
      targetDigest,
      foreignRoot.unknown.unknown_id,
    );
    const unknowns = [foreignRoot.unknown, middle.unknown];
    for (let index = 0; index < 125_000; index += 1) {
      const input = recordUnknownInputSchema.parse({
        question: `Target child ${index}`,
        severity: "medium",
        domain: "bundle-projection",
        required_authority: null,
        required_confidence: "derived",
        required_environment: null,
        recommended_probes: [],
        relationships: [
          { type: "depends-on", unknown_id: middle.unknown.unknown_id },
        ],
      });
      unknowns.push(
        createResidualUnknown(input, middle.evidence.evidence_id, targetDigest),
      );
    }
    const bundle = parseEvidenceBundle(
      createEvidenceBundle([foreignRoot.evidence, middle.evidence], unknowns),
    );

    expect(evidenceBundleForTarget(bundle, targetDigest)).toEqual(
      createEvidenceBundle([], []),
    );
  });
});
