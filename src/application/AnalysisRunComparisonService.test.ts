import { describe, expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
  updateResidualUnknown,
} from "../domain/residualUnknown.js";
import {
  compareAnalysisRuns,
  compareEvidenceAnalysisRuns,
  projectEvidenceBundleToAnalysisRun,
  projectEvidenceToAnalysisRun,
} from "./AnalysisRunComparisonService.js";

const SUBJECT_SHA_1 = "a".repeat(64);
const PROVIDER = { id: "ghidra", name: "Ghidra", version: "11.2" } as const;
const TARGET = {
  path: "/tmp/sample.elf",
  sha256: SUBJECT_SHA_1,
  format: "elf" as const,
  architecture: "x86_64" as const,
};

describe("AnalysisRunComparisonService Evidence comparison (#6338)", () => {
  it("projects and compares authenticated Evidence records without false presentation_only changes", () => {
    const leftEv = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { pass: 1 },
      result: {
        procedures: [{ address: "0x00401000", name: "entry", size_bytes: 32 }],
        findings: [
          {
            finding_id: "F-100",
            category: "network",
            severity: "low",
            confidence: "observed",
            title: "Cleartext endpoint",
            summary: "Uses http:// endpoint",
            locations: ["0x00401010"],
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });

    const rightEvIdentical = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { pass: 2 },
      result: {
        procedures: [{ address: "0x00401000", name: "entry", size_bytes: 32 }],
        findings: [
          {
            finding_id: "F-100",
            category: "network",
            severity: "low",
            confidence: "observed",
            title: "Cleartext endpoint",
            summary: "Uses http:// endpoint",
            locations: ["0x00401010"],
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });

    const identicalCompared = compareEvidenceAnalysisRuns(
      leftEv,
      rightEvIdentical,
    );
    expect(identicalCompared.ok).toBe(true);
    if (identicalCompared.ok) {
      expect(identicalCompared.value.status).toBe("unchanged");
      expect(identicalCompared.value.summary.presentation_only).toBe(0);
    }

    const rightEvChanged = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { pass: 3 },
      result: {
        procedures: [{ address: "0x00401000", name: "entry", size_bytes: 48 }],
        findings: [
          {
            finding_id: "F-100",
            category: "network",
            severity: "high",
            confidence: "observed",
            title: "Cleartext endpoint",
            summary: "Uses http:// endpoint for credentials",
            locations: ["0x00401010"],
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });

    const changedCompared = compareEvidenceAnalysisRuns(leftEv, rightEvChanged);
    expect(changedCompared.ok).toBe(true);
    if (changedCompared.ok) {
      expect(changedCompared.value.status).toBe("changed");
      expect(changedCompared.value.summary.changed).toBe(2);
    }
  });
});

describe("AnalysisRunComparisonService bundle coverage and unknown revisions (#6338)", () => {
  it("aggregates EvidenceBundle relationship_coverage conservatively across all records and retains highest unknown revision", () => {
    const completeEv = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { shard: 1 },
      result: {
        procedures: [{ address: "0x00401000", name: "entry", size_bytes: 32 }],
      },
      confidence: "observed",
      authority: "shipped-artifact",
      relationshipCoverage: { status: "complete" },
    });

    const partialEv = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { shard: 2 },
      result: {
        findings: [
          {
            finding_id: "F-200",
            category: "crypto",
            severity: "medium",
            confidence: "derived",
            title: "Static IV",
            summary: "Static initialization vector",
            locations: ["0x00402000"],
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
      relationshipCoverage: {
        status: "partial",
        limitations: ["Shard 2 stopped at call depth 4"],
      },
    });

    const unkRev1 = createResidualUnknown(
      recordUnknownInputSchema.parse({
        question: "Does entry validate TLS certificates?",
        severity: "high",
        domain: "network",
        supporting_evidence_ids: [completeEv.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "shipped-artifact",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
      completeEv.evidence_id,
      SUBJECT_SHA_1,
    );
    const unkRev2 = updateResidualUnknown(
      unkRev1,
      {
        unknown_id: unkRev1.unknown_id,
        expected_revision: 1,
        status: "resolved",
        severity: unkRev1.severity,
        supporting_evidence_ids: [
          completeEv.evidence_id,
          partialEv.evidence_id,
        ],
        contradicting_evidence_ids: [],
        required_authority: unkRev1.required_authority,
        required_confidence: unkRev1.required_confidence,
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        resolution: {
          disposition: "verified",
          rationale: "Confirmed TLS pin check in shard 2",
          evidence_ids: [partialEv.evidence_id],
        },
      },
      partialEv.evidence_id,
    );

    const bundle = createEvidenceBundle(
      [completeEv, partialEv],
      [unkRev2, unkRev1],
    );
    const projected = projectEvidenceBundleToAnalysisRun(
      bundle,
      "bundle-run-1",
    );

    expect(projected.result_type).toBe("evidence-bundle-run");
    expect(projected.relationship_coverage).toEqual({
      status: "partial",
      limitations: ["Shard 2 stopped at call depth 4"],
    });
    expect(projected.unknowns).toHaveLength(1);
    expect(projected.unknowns?.[0]?.revision).toBe(2);
    expect(projected.unknowns?.[0]?.status).toBe("resolved");
  });
});

describe("AnalysisRunComparisonService fail-closed validation (#6338)", () => {
  it("fails closed on invalid normalized_result field types and conflicting bundle item definitions", () => {
    const badSeverityEv = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: {},
      result: {
        findings: [
          {
            finding_id: "F-BAD",
            category: "crypto",
            severity: "bogus-severity",
            confidence: "observed",
            title: "Bad severity",
            summary: "Should fail closed",
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });

    expect(() => projectEvidenceToAnalysisRun(badSeverityEv)).toThrow(
      /Invalid finding severity/u,
    );

    const evA = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { a: 1 },
      result: {
        findings: [
          {
            finding_id: "F-CONFLICT",
            category: "crypto",
            severity: "low",
            confidence: "observed",
            title: "Title A",
            summary: "Summary A",
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });
    const evB = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_binary",
      parameters: { a: 2 },
      result: {
        findings: [
          {
            finding_id: "F-CONFLICT",
            category: "crypto",
            severity: "high",
            confidence: "observed",
            title: "Title B",
            summary: "Summary B",
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    });

    const conflictingBundle = createEvidenceBundle([evA, evB], []);
    expect(() =>
      projectEvidenceBundleToAnalysisRun(conflictingBundle, "conflict-run"),
    ).toThrow(/Conflicting finding_id definitions/u);
  });
});

const makeCorroboratingRecord = (
  providerId: string,
  sha256: string,
  sev: "medium" | "high",
) =>
  createEvidence(
    { path: "/bin/daemon.elf", sha256, format: "elf", architecture: "x86_64" },
    { id: providerId, name: providerId, version: "6.8.0" },
    {
      predicateType: "rea.binary.triage.v1",
      operation: "analyze_binary_triage",
      parameters: {},
      rawResult: null,
      result: {
        findings: [
          {
            finding_id: "F-CORROBORATED-01",
            category: "crypto",
            severity: sev,
            confidence: "observed",
            status: "observed",
            title: "Static IV in AES-GCM nonce setup",
            summary: "Nonce buffer initialized with constant 12-byte IV.",
          },
        ],
        obligations: [
          {
            obligation_id: "OBL-NONCE-01",
            category: "crypto-invariant",
            description:
              "Verify whether IV is overwritten before EVP_EncryptInit_ex.",
            status: "open",
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
      relationshipCoverage: { status: "complete" },
    },
  );

describe("multi-record EvidenceBundle Ingression, Corroboration, and Subject-Conflict Coverage (#6338)", () => {
  it("merges corroborating evidence_ids across bundle records, reproduces deterministically, and rejects multi-subject bundles", () => {
    const shaMain = "a".repeat(64);
    const shaOther = "b".repeat(64);

    const recLeft1 = makeCorroboratingRecord("rea-ghidra", shaMain, "medium");
    const recLeft2 = makeCorroboratingRecord("rea-rizin", shaMain, "medium");
    const recRight1 = makeCorroboratingRecord("rea-ghidra", shaMain, "high");
    const recRight2 = makeCorroboratingRecord("rea-rizin", shaMain, "high");

    const bundleLeft = createEvidenceBundle([recLeft1, recLeft2], []);
    const bundleLeftReversed = createEvidenceBundle([recLeft2, recLeft1], []);
    const bundleRight = createEvidenceBundle([recRight1, recRight2], []);

    const cmpForward = compareAnalysisRuns(
      projectEvidenceBundleToAnalysisRun(bundleLeft, "bundle-left"),
      projectEvidenceBundleToAnalysisRun(bundleRight, "bundle-right"),
    );
    const cmpReverse = compareAnalysisRuns(
      projectEvidenceBundleToAnalysisRun(bundleLeftReversed, "bundle-left"),
      projectEvidenceBundleToAnalysisRun(bundleRight, "bundle-right"),
    );

    expect(cmpForward.ok).toBe(true);
    expect(cmpReverse.ok).toBe(true);
    if (!cmpForward.ok || !cmpReverse.ok) return;

    expect(cmpForward.value).toEqual(cmpReverse.value);
    const findingDelta = cmpForward.value.items.find(
      (i) => i.item_key === "finding:F-CORROBORATED-01",
    );
    expect(findingDelta?.status).toBe("changed");
    expect(findingDelta?.evidence_links).toHaveLength(4);

    const recWrongSubject = makeCorroboratingRecord(
      "rea-objdump",
      shaOther,
      "medium",
    );
    const mixedSubjectBundle = createEvidenceBundle(
      [recLeft1, recWrongSubject],
      [],
    );
    expect(() =>
      projectEvidenceBundleToAnalysisRun(mixedSubjectBundle, "bad-bundle"),
    ).toThrow(/conflicting subject artifacts/i);
  });
});
