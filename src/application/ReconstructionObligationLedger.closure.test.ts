import { describe, expect, it } from "vitest";

import {
  boundProofEvidence,
  build,
  originalCases,
  processEvidence,
  proofEvidence,
  request,
  reviewedObligation,
} from "./ReconstructionObligationLedger.fixture.js";

describe("reconstruction obligation ledger", () => {
  it("emits the complete deterministic ledger and closure identity", () => {
    const evidence = proofEvidence("review");
    const reviewed = [
      reviewedObligation("obl.review.one", evidence.evidence_id),
      reviewedObligation("obl.review.two", evidence.evidence_id),
    ];
    const first = build(
      request([evidence], { reviewed_obligations: reviewed }),
    );
    const second = build(
      request([evidence], { reviewed_obligations: reviewed }),
    );
    expect(first.obligations).toHaveLength(2);
    expect(first).toEqual(second);
    expect(first.obligations[0]?.source_state).toBe("reviewed");
    expect(first.status).toBe("open");
  });

  it("does not let green unit evidence close a packaged-process obligation", () => {
    const capture = processEvidence();
    const proof = proofEvidence("green-unit");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const unitBinding = {
      obligation_id: obligation.obligation_id,
      owner: {
        module_path: "src/processOwner.ts",
        symbol: "runProcess",
        owner_sha256: "1".repeat(64),
      },
      parser_type: null,
      original_cases: originalCases(obligation, capture.evidence_id),
      fixtures: obligation.required_case_kinds.map((caseKind) => ({
        fixture_id: `fixture.${caseKind}`,
        case_kind: caseKind,
        authority: "unit" as const,
        evidence_ids: [proof.evidence_id],
      })),
      verifier: {
        verifier_id: "verifier.unit",
        claim_id: "claim.process",
        command: "npm test -- processOwner",
        authority: "unit" as const,
        status: "pass" as const,
        result_evidence_id: proof.evidence_id,
        enumerated_obligation_ids: [obligation.obligation_id],
        nondeterminism: {
          mode: "total-order" as const,
          specification: "Exact unit-call order.",
        },
      },
    };

    const result = build(
      request([capture, proof], {
        manifest: {
          bindings: [unitBinding],
          contradictions: [],
        },
      }),
    );
    const evaluated = result.obligations[0];
    expect(evaluated?.status).toBe("implemented");
    expect(evaluated?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "weak-fixture-authority",
        "weak-verifier-authority",
      ]),
    );
    expect(result.status).toBe("open");
  });
});

describe("reconstruction obligation ledger case closure", () => {
  it("keeps unobserved original cases open", () => {
    const capture = processEvidence();
    const proof = proofEvidence("packaged-original-gap");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const result = build(
      request([capture, proof], {
        manifest: {
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "4".repeat(64),
              },
              parser_type: null,
              original_cases: obligation.observed_cases,
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification:
                    "Startup precedes teardown; worker completion is unordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]?.status).toBe("implemented");
    expect(result.obligations[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-original-case",
          detail: expect.stringContaining("negative"),
        }),
        expect.objectContaining({
          code: "missing-original-case",
          detail: expect.stringContaining("cancellation"),
        }),
      ]),
    );
    expect(result.status).toBe("open");
  });

  it("closes only when every required case and verifier has comparable authority", () => {
    const capture = processEvidence();
    const initial = build(request([capture]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const fixtureIds = obligation.required_case_kinds.map(
      (caseKind) => `packaged.${caseKind}`,
    );
    const proof = boundProofEvidence("packaged", {
      obligation_ids: [obligation.obligation_id],
      fixture_ids: fixtureIds,
      case_kinds: obligation.required_case_kinds,
      verifier_ids: ["verifier.packaged"],
      claim_ids: ["claim.process"],
    });
    const result = build(
      request([capture, proof], {
        manifest: {
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "2".repeat(64),
              },
              parser_type: null,
              original_cases: originalCases(obligation, capture.evidence_id),
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification:
                    "Startup precedes teardown; worker completion is unordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]).toMatchObject({
      status: "verified",
      diagnostics: [],
    });
    expect(result.status).toBe("ready");
    expect(result.summary.required_open).toBe(0);
  });
});
