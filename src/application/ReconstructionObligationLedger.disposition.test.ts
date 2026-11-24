import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { reconstructionObligationLedgerClosureDigest } from "../domain/reconstructionObligationLedgerIntegrity.js";
import {
  reconstructionObligationLedgerSchema,
  type ReconstructionObligationLedger,
  type ReconstructionObligationManifest,
  type ReviewedReconstructionObligation,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import {
  boundProofEvidence,
  build,
  processEvidence,
  proofEvidence,
  readyProcessLedgerRequest,
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

/** The only diagnostic is the retirement, and it carries the caller's reason. */
const expectOnlyRetirement = (
  obligation: ReconstructionObligationLedger["obligations"][number] | undefined,
  code: "out-of-scope" | "not-applicable",
  reason = REASON,
): void => {
  expect(obligation?.diagnostics.map(({ code: actual }) => actual)).toEqual([
    code,
  ]);
  expect(obligation?.diagnostics[0]?.detail).toContain(reason);
};

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
      });
      expectOnlyRetirement(ledger.obligations[0], "not-applicable");
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
    });
    expectOnlyRetirement(ledger.obligations[0], "out-of-scope");
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

describe("reconstruction obligation blocked claim contradiction", () => {
  it("fails the ledger when a blocked reviewed claim carries an authenticated contradiction", () => {
    const review = proofEvidence("blocked-review");
    const contradicting = proofEvidence("blocked-contradiction");
    const ledger = build(
      request([review, contradicting], {
        reviewed_obligations: [
          {
            ...reviewedObligation("obl.review.blocked", review.evidence_id),
            disposition: "blocked",
          },
        ],
        manifest: {
          bindings: [],
          contradictions: [
            {
              obligation_id: "obl.review.blocked",
              evidence_ids: [review.evidence_id, contradicting.evidence_id],
            },
          ],
        },
      }),
    );

    // The blocked status ranks ahead of contradicted, but blocking does not
    // hide the contradiction: contradicted required work fails closure.
    expect(ledger.obligations[0]).toMatchObject({
      origin: "reviewed",
      required: true,
      status: "blocked",
    });
    expect(ledger.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["blocked", "contradiction"]),
    );
    expect(ledger.reports.contradicted_obligation_ids).toEqual([
      "obl.review.blocked",
    ]);
    expect(ledger.status).toBe("failed");
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

  it.each([
    ["failing", "fail", "failed", ["not-applicable", "verifier-failed"]],
    ["passing", "pass", "open", ["not-applicable"]],
  ] as const)(
    "still checks a %s verifier supplied for a retired claim",
    (_, verifierStatus, ledgerStatus, codes) => {
      const ready = readyProcessLedgerRequest();
      const binding = ready.manifest?.bindings[0];
      const capture = ready.evidence_bundle.records[0];
      if (
        binding === undefined ||
        binding.verifier === null ||
        capture === undefined
      )
        throw new Error("Expected a bound process obligation");
      const ledger = build({
        ...ready,
        reviewed_obligations: [
          retired(binding.obligation_id, capture.evidence_id, "not-applicable"),
        ],
        manifest: {
          bindings: [
            {
              ...binding,
              verifier: { ...binding.verifier, status: verifierStatus },
            },
          ],
          contradictions: [],
        },
      });

      // A verifier result that was supplied and failed stays visible on a
      // retired claim and fails the ledger; a passing one leaves it open.
      expect(ledger.obligations[0]).toMatchObject({
        origin: "generated",
        required: true,
        status: "out-of-scope",
      });
      expect(
        ledger.obligations[0]?.diagnostics.map(({ code }) => code),
      ).toEqual(codes);
      expect(ledger.status).toBe(ledgerStatus);
    },
  );

  it.each([
    [
      "an authenticated contradiction",
      true,
      "failed",
      ["contradiction", "out-of-scope"],
    ],
    ["no contradiction", false, "open", ["out-of-scope"]],
  ] as const)(
    "fails the ledger when a retired claim carries %s",
    (_, contradicted, ledgerStatus, codes) => {
      const capture = processEvidence();
      const review = proofEvidence("contradicted-review");
      const generated = build(request([capture])).obligations[0];
      if (generated === undefined)
        throw new Error("Expected process obligation");
      const ledger = build(
        request([capture, review], {
          reviewed_obligations: [
            retired(
              generated.obligation_id,
              review.evidence_id,
              "out-of-scope",
            ),
          ],
          manifest: {
            bindings: [],
            contradictions: contradicted
              ? [
                  {
                    obligation_id: generated.obligation_id,
                    evidence_ids: [capture.evidence_id, review.evidence_id],
                  },
                ]
              : [],
          },
        }),
      );

      // Retiring does not hide the contradiction, so the ledger cannot stay
      // merely open: contradicted required work fails closure.
      expect(ledger.obligations[0]).toMatchObject({
        origin: "generated",
        required: true,
        status: "out-of-scope",
      });
      expect(
        ledger.obligations[0]?.diagnostics.map(({ code }) => code),
      ).toEqual(codes);
      expect(ledger.reports.contradicted_obligation_ids).toEqual(
        contradicted ? [generated.obligation_id] : [],
      );
      expect(ledger.status).toBe(ledgerStatus);
    },
  );
});

const LEDGER_RANK = { failed: 0, unknown: 1, open: 2, ready: 3 } as const;

/** Build with the reviewed records in both input orders; both must agree. */
const buildBothOrders = (
  records: Parameters<typeof request>[0],
  reviewed: readonly ReviewedReconstructionObligation[],
): ReconstructionObligationLedger => {
  const forward = build(
    request(records, { reviewed_obligations: [...reviewed] }),
  );
  expect(
    build(request(records, { reviewed_obligations: [...reviewed].reverse() })),
  ).toEqual(forward);
  return forward;
};

const codesOf = (
  obligation: ReconstructionObligationLedger["obligations"][number] | undefined,
): string[] => [...new Set(obligation?.diagnostics.map(({ code }) => code))];

describe("reconstruction obligation competing retirements", () => {
  it.each([
    ["an active record", "active"],
    ["a blocked record", "blocked"],
    ["a retiring record with the same disposition", "out-of-scope"],
    ["a retiring record with another disposition", "not-applicable"],
  ] as const)(
    "treats a retiring record beside %s for one generated ID like any other duplicate, in either order",
    (_, secondDisposition) => {
      const capture = processEvidence();
      const review = proofEvidence("double-review");
      const generated = build(request([capture])).obligations[0];
      if (generated === undefined)
        throw new Error("Expected process obligation");
      const first = retired(
        generated.obligation_id,
        review.evidence_id,
        "out-of-scope",
        "First sweep.",
      );
      const second =
        secondDisposition === "active" || secondDisposition === "blocked"
          ? {
              ...reviewedObligation(
                generated.obligation_id,
                review.evidence_id,
              ),
              disposition: secondDisposition,
            }
          : retired(
              generated.obligation_id,
              review.evidence_id,
              secondDisposition,
              "Second sweep.",
            );
      // The plain duplicate path: one active reviewed record for the ID.
      const plainDuplicate = build(
        request([capture, review], {
          reviewed_obligations: [
            reviewedObligation(generated.obligation_id, review.evidence_id),
          ],
        }),
      );
      const ledger = buildBothOrders([capture, review], [first, second]);

      expect(ledger.obligations).toHaveLength(1);
      // Same precedence and diagnostic codes as the plain duplicate: no
      // retirement is applied, so the claim stays unknown and keeps demanding
      // its closure work.
      expect(plainDuplicate.obligations[0]?.status).toBe("unknown");
      expect(ledger.obligations[0]).toMatchObject({
        origin: "generated",
        required: true,
        status: "unknown",
      });
      expect(codesOf(ledger.obligations[0])).toEqual(
        codesOf(plainDuplicate.obligations[0]),
      );
      expect(codesOf(ledger.obligations[0])).not.toContain("out-of-scope");
      expect(codesOf(ledger.obligations[0])).not.toContain("not-applicable");
      // No review silently wins: each retiring reason stays in a
      // duplicate-definition diagnostic.
      const reasons =
        second.disposition === "out-of-scope" ||
        second.disposition === "not-applicable"
          ? ["First sweep.", "Second sweep."]
          : ["First sweep."];
      for (const reason of reasons)
        expect(
          ledger.obligations[0]?.diagnostics.filter(
            ({ code, detail }) =>
              code === "duplicate-definition" && detail.includes(reason),
          ),
        ).toHaveLength(1);
      expect(ledger.summary).toMatchObject({ required: 1, required_open: 1 });
      expect(ledger.status).toBe("unknown");
      expect(ledger.status).toBe(plainDuplicate.status);
    },
  );

  it.each([
    ["an active record", "active"],
    ["a retiring record", "not-applicable"],
  ] as const)(
    "does not retire a reviewed obligation defined again by %s, in either order",
    (_, secondDisposition) => {
      const review = proofEvidence("reviewed-duplicate");
      const first = retired(
        "obl.review.twice",
        review.evidence_id,
        "out-of-scope",
      );
      const second =
        secondDisposition === "active"
          ? reviewedObligation("obl.review.twice", review.evidence_id)
          : retired(
              "obl.review.twice",
              review.evidence_id,
              secondDisposition,
              "Second sweep.",
            );
      const ledger = buildBothOrders([review], [first, second]);

      expect(ledger.obligations).toHaveLength(1);
      expect(ledger.obligations[0]).toMatchObject({
        origin: "reviewed",
        status: "unknown",
      });
      expect(codesOf(ledger.obligations[0])).toContain("duplicate-definition");
      expect(codesOf(ledger.obligations[0])).not.toContain("out-of-scope");
      expect(codesOf(ledger.obligations[0])).not.toContain("not-applicable");
      expect(ledger.status).toBe("unknown");
    },
  );

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

describe("reconstruction obligation retirement never improves the ledger", () => {
  it("keeps the ledger unknown when a claim with unavailable authority is retired, in either order", () => {
    const capture = processEvidence({
      residual_unknowns: [{ scope: "network", reason: "Second run only." }],
    });
    const review = proofEvidence("unknown-review");
    const sibling = reviewedObligation(
      "obl.review.sibling",
      review.evidence_id,
    );
    const before = build(
      request([capture, review], { reviewed_obligations: [sibling] }),
    );
    const generated = before.obligations.find(
      ({ origin }) => origin === "generated",
    );
    if (generated === undefined) throw new Error("Expected process obligation");
    const after = buildBothOrders(
      [capture, review],
      [
        retired(generated.obligation_id, review.evidence_id, "out-of-scope"),
        sibling,
      ],
    );

    expect(generated.status).toBe("unknown");
    expect(before.status).toBe("unknown");
    // The retired claim reports out-of-scope, but its unavailable authority
    // stays visible and still keeps closure unknown rather than open.
    const retiredClaim = after.obligations.find(
      ({ obligation_id: id }) => id === generated.obligation_id,
    );
    expect(retiredClaim).toMatchObject({
      required: true,
      status: "out-of-scope",
    });
    expect(codesOf(retiredClaim)).toContain("unavailable-authority");
    expect(after.status).toBe("unknown");
    expect(LEDGER_RANK[after.status]).toBeLessThanOrEqual(
      LEDGER_RANK[before.status],
    );
  });
});

/** Re-commit a ledger as main retained it: no limitation kinds, given status. */
const retainedFromMain = (
  ledger: ReconstructionObligationLedger,
  status: ReconstructionObligationLedger["status"],
) => {
  const {
    limitation_kinds: _kinds,
    closure_digest: _digest,
    ...retained
  } = ledger;
  const legacy = { ...retained, status };
  return {
    ...legacy,
    closure_digest: reconstructionObligationLedgerClosureDigest(legacy),
  };
};

describe("reconstruction obligation ledgers retained from main", () => {
  it.each([
    ["a residual unknown", "residual-unknown"],
    ["unavailable authority", "unavailable-authority"],
  ] as const)(
    "parses a blocked claim with %s stored open, unchanged",
    (_, code) => {
      const review = proofEvidence("blocked-residue");
      const ledger = build(
        request([review], {
          reviewed_obligations: [
            {
              ...reviewedObligation("obl.review.blocked", review.evidence_id),
              disposition: "blocked",
              ...(code === "residual-unknown"
                ? { residual_unknown_ids: ["unk.network"] }
                : { unavailable_authority: ["Second run only."] }),
            },
          ],
        }),
      );
      const retained = retainedFromMain(ledger, "open");

      expect(retained).not.toHaveProperty("limitation_kinds");
      expect(reconstructionObligationLedgerSchema.parse(retained)).toEqual(
        retained,
      );
      // A blocked claim keeps main's status rule, so new output agrees.
      expect(ledger.obligations[0]).toMatchObject({
        required: true,
        status: "blocked",
      });
      expect(codesOf(ledger.obligations[0])).toEqual(
        expect.arrayContaining(["blocked", code]),
      );
      expect(ledger.status).toBe("open");
    },
  );

  it("reads a retired claim with unavailable authority stored open only without limitation kinds", () => {
    const capture = processEvidence({
      residual_unknowns: [{ scope: "network", reason: "Second run only." }],
    });
    const review = proofEvidence("legacy-review");
    const generated = build(request([capture])).obligations[0];
    if (generated === undefined) throw new Error("Expected process obligation");
    const ledger = build(
      request([capture, review], {
        reviewed_obligations: [
          retired(generated.obligation_id, review.evidence_id, "out-of-scope"),
        ],
      }),
    );
    const retained = retainedFromMain(ledger, "open");
    const { closure_digest: _digest, ...current } = ledger;
    const relabeled = { ...current, status: "open" as const };

    expect(ledger.status).toBe("unknown");
    // Main read this ledger open; a ledger retained before limitation kinds
    // keeps that reading.
    expect(reconstructionObligationLedgerSchema.parse(retained)).toEqual(
      retained,
    );
    // With limitation kinds recorded, retirement must not read as open.
    const result = reconstructionObligationLedgerSchema.safeParse({
      ...relabeled,
      closure_digest: reconstructionObligationLedgerClosureDigest(relabeled),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path }) => path)).toContainEqual([
      "status",
    ]);
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
