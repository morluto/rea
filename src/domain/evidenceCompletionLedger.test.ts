import { describe, expect, it } from "vitest";

import {
  createEvidenceCompletionLedger,
  evidenceCompletionLedgerSchema,
  type EvidenceCompletionStatus,
} from "./evidenceCompletionLedger.js";

const evidenceId = (digit: string): string => `ev_${digit.repeat(64)}`;

const record = (
  claimId: string,
  status: EvidenceCompletionStatus,
  evidenceIds: readonly string[] = [evidenceId("1")],
) => ({ claim_id: claimId, status, evidence_ids: evidenceIds });

describe("Evidence completion ledger", () => {
  it("marks only an all-pass ledger complete", () => {
    const ledger = createEvidenceCompletionLedger([
      record("scenario.launch", "pass"),
      record("scenario.shutdown", "pass", [evidenceId("2")]),
    ]);

    expect(ledger.summary).toEqual({
      total: 2,
      pass: 2,
      fail: 0,
      unsupported: 0,
      truncated: 0,
      unknown: 0,
      complete: true,
    });
  });

  it.each(["fail", "truncated", "unknown"] as const)(
    "does not count %s as pass",
    (status) => {
      const ledger = createEvidenceCompletionLedger([
        record("scenario.pass", "pass"),
        record(`scenario.${status}`, status, [evidenceId("2")]),
      ]);

      expect(ledger.summary).toMatchObject({ pass: 1, complete: false });
      expect(ledger.summary[status]).toBe(1);
    },
  );

  it("canonicalizes claim and Evidence ID ordering", () => {
    const left = createEvidenceCompletionLedger([
      record("scenario.z", "pass", [evidenceId("2"), evidenceId("1")]),
      record("scenario.a", "unknown", [evidenceId("3")]),
    ]);
    const right = createEvidenceCompletionLedger([
      record("scenario.a", "unknown", [evidenceId("3")]),
      record("scenario.z", "pass", [evidenceId("1"), evidenceId("2")]),
    ]);

    expect(left).toEqual(right);
    expect(left.records).toEqual([
      record("scenario.a", "unknown", [evidenceId("3")]),
      record("scenario.z", "pass", [evidenceId("1"), evidenceId("2")]),
    ]);
    expect(left.ledger_id).toBe(
      "ecl_7c5d6bed5031f94a1e122ecce6a6be85af38b1972f2921e502305354851cce94",
    );
  });

  it("rejects independently tampered receipt fields", () => {
    const ledger = createEvidenceCompletionLedger([
      record("scenario.valid", "pass"),
    ]);
    for (const [field, value] of [
      ["summary", { ...ledger.summary, complete: false }],
      ["ledger_id", `ecl_${"0".repeat(64)}`],
    ] as const) {
      const parsed = evidenceCompletionLedgerSchema.safeParse({
        ...ledger,
        [field]: value,
      });
      expect(parsed).toMatchObject({
        success: false,
        error: { issues: [{ path: [field] }] },
      });
    }
  });

  it("rejects a path-bearing field in a receipt record", () => {
    const ledger = createEvidenceCompletionLedger([
      record("scenario.path-free", "pass"),
    ]);
    expect(
      evidenceCompletionLedgerSchema.safeParse({
        ...ledger,
        records: [
          {
            ...record("scenario.path-free", "pass"),
            local_path: "/private/operator/input.bin",
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: "unrecognized_keys",
            path: ["records", 0],
            keys: ["local_path"],
          },
        ],
      },
    });
  });
});
