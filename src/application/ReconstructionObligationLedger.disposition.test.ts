import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type {
  ReconstructionObligationManifest,
  ReviewedReconstructionObligation,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import {
  boundProofEvidence,
  build,
  processEvidence,
  proofEvidence,
  request,
  reviewedObligation,
} from "./ReconstructionObligationLedger.fixture.js";
import { buildReconstructionObligationLedgerEvidence } from "./ReconstructionObligationLedgerService.js";

const REASON = "Decoy boundary in dead code; no reachable caller.";

const retired = (
  obligationId: string,
  evidenceId: string,
  disposition: "out-of-scope" | "not-applicable",
  reason = REASON,
): ReviewedReconstructionObligation => ({
  ...reviewedObligation(obligationId, evidenceId),
  disposition,
  disposition_reason: reason,
});

/** Binding with an owner but no fixtures, original cases, or verifier. */
const fixturelessBinding = (
  obligationId: string,
): ReconstructionObligationManifest["bindings"][number] => ({
  obligation_id: obligationId,
  owner: {
    module_path: "src/processOwner.ts",
    symbol: "runProcess",
    owner_sha256: "7".repeat(64),
  },
  parser_type: null,
  original_cases: [],
  fixtures: [],
  verifier: null,
});

describe("reconstruction obligation analyst disposition", () => {
  it.each([
    ["without a binding", false],
    ["with a fixtureless binding", true],
  ])(
    "retires a generated obligation %s without competing with it",
    (_, bound) => {
      const capture = processEvidence();
      const review = proofEvidence("retire-review");
      const generated = build(request([capture])).obligations[0];
      if (generated === undefined)
        throw new Error("Expected process obligation");
      const ledger = build(
        request([capture, review], {
          reviewed_obligations: [
            retired(
              generated.obligation_id,
              review.evidence_id,
              "not-applicable",
            ),
          ],
          manifest: {
            bindings: bound
              ? [fixturelessBinding(generated.obligation_id)]
              : [],
            contradictions: [],
          },
        }),
      );

      expect(ledger.obligations).toHaveLength(1);
      expect(ledger.obligations[0]).toMatchObject({
        obligation_id: generated.obligation_id,
        origin: "generated",
        title: generated.title,
        family: generated.family,
        required: true,
        status: "out-of-scope",
        required_next_evidence: ["Bind an owner and verifier."],
        diagnostics: [
          {
            code: "not-applicable",
            detail: `Reviewed disposition marks this obligation not applicable; it remains visible. Reason: ${REASON}`,
          },
        ],
      });
      expect(
        ledger.obligations[0]?.authority_references.map(
          ({ evidence_id: id }) => id,
        ),
      ).toEqual([capture.evidence_id, review.evidence_id].sort());
      // Retiring keeps the claim required: it is not closure, so the ledger
      // stays open rather than self-certifying as ready.
      expect(ledger.summary).toMatchObject({
        total: 1,
        required: 1,
        required_open: 1,
      });
      expect(ledger.reports.missing_owner_obligation_ids).toEqual([]);
      expect(ledger.reports.missing_verifier_obligation_ids).toEqual([]);
      expect(ledger.status).toBe("open");
    },
  );

  it("keeps a required out-of-scope reviewed obligation required and the ledger open", () => {
    const review = proofEvidence("scope-review");
    const ledger = build(
      request([review], {
        reviewed_obligations: [
          {
            ...retired("obl.review.scoped", review.evidence_id, "out-of-scope"),
            required: true,
          },
        ],
      }),
    );

    expect(ledger.obligations[0]).toMatchObject({
      origin: "reviewed",
      required: true,
      status: "out-of-scope",
      diagnostics: [
        {
          code: "out-of-scope",
          detail: `Reviewed disposition marks this obligation out of scope; it remains visible. Reason: ${REASON}`,
        },
      ],
    });
    expect(ledger.summary.by_status).toContainEqual({
      key: "out-of-scope",
      count: 1,
    });
    expect(ledger.summary.required_open).toBe(1);
    expect(ledger.status).toBe("open");
  });

  it("does not hide sibling obligations or their closure work", () => {
    const capture = processEvidence();
    const review = proofEvidence("sibling-review");
    const generated = build(request([capture])).obligations[0];
    if (generated === undefined) throw new Error("Expected process obligation");
    const sibling = reviewedObligation(
      "obl.review.sibling",
      review.evidence_id,
    );
    const ledger = build(
      request([capture, review], {
        reviewed_obligations: [
          retired(generated.obligation_id, review.evidence_id, "out-of-scope"),
          sibling,
        ],
      }),
    );

    expect(ledger.obligations.map(({ obligation_id: id }) => id)).toEqual(
      [generated.obligation_id, sibling.obligation_id].sort(),
    );
    const open = ledger.obligations.find(
      ({ obligation_id: id }) => id === sibling.obligation_id,
    );
    expect(open).toMatchObject({ required: true, status: "unowned" });
    expect(open?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["missing-owner", "missing-original-case"]),
    );
    expect(ledger.reports.missing_owner_obligation_ids).toEqual([
      sibling.obligation_id,
    ]);
    // The retired generated obligation stays required too.
    expect(ledger.summary).toMatchObject({ required: 2, required_open: 2 });
    expect(ledger.status).toBe("open");
  });
});

describe("reconstruction obligation retired claim proof", () => {
  it.each([
    ["failing", false, "failed", ["fixture-failed", "not-applicable"]],
    ["passing", true, "open", ["not-applicable"]],
  ] as const)(
    "still checks a %s fixture proof supplied for a retired claim",
    (_, passed, ledgerStatus, codes) => {
      const capture = processEvidence();
      const generated = build(request([capture])).obligations[0];
      if (generated === undefined)
        throw new Error("Expected process obligation");
      const proof = boundProofEvidence("retired-proof", {
        bindings: [
          {
            obligation_id: generated.obligation_id,
            obligation_version: generated.obligation_version,
            owner_sha256: "7".repeat(64),
            fixtures: [
              {
                fixture_id: "packaged.positive",
                case_kind: "positive",
                passed,
              },
            ],
            verifiers: [],
          },
        ],
      });
      const ledger = build(
        request([capture, proof], {
          reviewed_obligations: [
            retired(
              generated.obligation_id,
              proof.evidence_id,
              "not-applicable",
            ),
          ],
          manifest: {
            bindings: [
              {
                ...fixturelessBinding(generated.obligation_id),
                fixtures: [
                  {
                    fixture_id: "packaged.positive",
                    case_kind: "positive",
                    authority: "packaged-process",
                    evidence_ids: [proof.evidence_id],
                  },
                ],
              },
            ],
            contradictions: [],
          },
        }),
      );

      // Missing cases and the missing verifier are not demanded of a retired
      // claim, but a proof that was supplied and failed stays visible.
      expect(ledger.obligations[0]).toMatchObject({
        origin: "generated",
        required: true,
        status: "out-of-scope",
      });
      expect(
        ledger.obligations[0]?.diagnostics.map(({ code }) => code),
      ).toEqual(codes);
      expect(ledger.reports.missing_verifier_obligation_ids).toEqual([]);
      expect(ledger.status).toBe(ledgerStatus);
    },
  );
});

describe("reconstruction obligation competing retirements", () => {
  it("reports two retiring records for one generated ID as competing definitions in any order", () => {
    const capture = processEvidence();
    const review = proofEvidence("double-review");
    const generated = build(request([capture])).obligations[0];
    if (generated === undefined) throw new Error("Expected process obligation");
    const first = retired(
      generated.obligation_id,
      review.evidence_id,
      "out-of-scope",
      "First sweep.",
    );
    const second = retired(
      generated.obligation_id,
      review.evidence_id,
      "not-applicable",
      "Second sweep.",
    );
    const forward = build(
      request([capture, review], { reviewed_obligations: [first, second] }),
    );
    const reversed = build(
      request([capture, review], { reviewed_obligations: [second, first] }),
    );

    expect(forward).toEqual(reversed);
    expect(forward.obligations).toHaveLength(1);
    expect(forward.obligations[0]).toMatchObject({
      origin: "generated",
      required: true,
      status: "out-of-scope",
    });
    expect(
      forward.obligations[0]?.diagnostics.map(({ code }) => code),
    ).toContain("duplicate-definition");
    expect(forward.summary).toMatchObject({ required: 1, required_open: 1 });
  });

  it("does not retire a generated claim with a reviewed record for another version", () => {
    const capture = processEvidence();
    const review = proofEvidence("version-review");
    const generated = build(request([capture])).obligations[0];
    if (generated === undefined) throw new Error("Expected process obligation");
    expect(generated.obligation_version).toBe(1);
    const ledger = build(
      request([capture, review], {
        reviewed_obligations: [
          {
            ...retired(
              generated.obligation_id,
              review.evidence_id,
              "not-applicable",
            ),
            obligation_version: 2,
          },
        ],
      }),
    );

    expect(ledger.obligations).toHaveLength(1);
    expect(ledger.obligations[0]).toMatchObject({
      origin: "generated",
      obligation_version: 1,
      required: true,
      status: "unknown",
    });
    const codes = ledger.obligations[0]?.diagnostics.map(({ code }) => code);
    expect(codes).toContain("duplicate-definition");
    expect(codes).not.toContain("not-applicable");
    expect(ledger.status).toBe("unknown");
  });
});

describe("reconstruction obligation analyst disposition input", () => {
  it.each([
    ["an empty reason", ""],
    ["a blank reason", "   "],
    ["no reason", undefined],
  ])("rejects a retiring disposition with %s", (_, reason) => {
    const review = proofEvidence("reason-review");
    const result = buildReconstructionObligationLedgerEvidence({
      ...request([review]),
      reviewed_obligations: [
        {
          ...reviewedObligation("obl.review.unreasoned", review.evidence_id),
          disposition: "out-of-scope",
          ...(reason === undefined ? {} : { disposition_reason: reason }),
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an input error");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect((result.error as AnalysisInputError).issues).toContainEqual(
      expect.objectContaining({
        path: ["reviewed_obligations", 0, "disposition_reason"],
      }),
    );
  });

  it("rejects a reason on a disposition that does not retire the obligation", () => {
    const review = proofEvidence("active-review");
    const result = buildReconstructionObligationLedgerEvidence({
      ...request([review]),
      reviewed_obligations: [
        {
          ...reviewedObligation("obl.review.active", review.evidence_id),
          disposition_reason: REASON,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an input error");
    expect((result.error as AnalysisInputError).issues).toContainEqual(
      expect.objectContaining({
        path: ["reviewed_obligations", 0, "disposition_reason"],
        reason: "unknown_argument",
      }),
    );
  });

  it("still reports an active reviewed definition that reuses a generated ID", () => {
    const capture = processEvidence();
    const generated = build(request([capture])).obligations[0];
    if (generated === undefined) throw new Error("Expected process obligation");
    const ledger = build(
      request([capture], {
        reviewed_obligations: [
          {
            ...reviewedObligation(generated.obligation_id, capture.evidence_id),
            disposition: "blocked",
          },
        ],
      }),
    );

    expect(ledger.obligations[0]).toMatchObject({
      required: true,
      status: "unknown",
    });
    expect(
      ledger.obligations[0]?.diagnostics.map(({ code }) => code),
    ).toContain("duplicate-definition");
  });
});
