import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
} from "../domain/residualUnknown.js";
import {
  exportFindingsToSarif,
  parseSarifLog,
  serializeSarifLog,
} from "../domain/sarifExport.js";
import {
  exportEvidenceBundleToSarif,
  exportEvidenceToSarif,
  extractStructuredFindingsFromEvidence,
  tryExportEvidenceBundleToSarif,
  tryExportEvidenceToSarif,
  writeSarifLogFile,
} from "./SarifExportService.js";

const EV_ID_DANGLING = `ev_${"9".repeat(64)}`;
const ARTIFACT_SHA_1 = "a".repeat(64);

describe("SarifExportService Evidence and EvidenceBundle integration (#6332)", () => {
  it("exports authenticated Evidence and EvidenceBundle records and detects tampering", async () => {
    const evidence1 = createEvidence(
      {
        path: "/tmp/app-client.js",
        sha256: ARTIFACT_SHA_1,
        format: "javascript",
      },
      {
        id: "rea-js-static",
        name: "REA JavaScript Analyzer",
        version: "6.8.0",
      },
      {
        predicateType: "rea.javascript.findings.v1",
        operation: "analyze_javascript_application",
        parameters: {},
        rawResult: null,
        result: {
          findings: [
            {
              finding_id: "JS-SECRET-01",
              rule_id: "rea/hardcoded-secret/api-key",
              category: "hardcoded-secret",
              severity: "critical",
              confidence: "observed",
              title: "Embedded production API token",
              summary: "Hardcoded bearer token assigned to AUTH_HEADER.",
              locations: [
                {
                  uri: "src/app-client.js",
                  startLine: 18,
                  startColumn: 3,
                  endLine: 18,
                  endColumn: 52,
                },
              ],
            },
            {
              finding_id: "JS-NO-LOC-02",
              category: "policy-violation",
              summary: "Missing CSP configuration in bundle metadata.",
              locations: null,
            },
          ],
        },
        confidence: "observed",
        authority: "shipped-artifact",
        environment: null,
        limitations: ["Dynamic eval expressions were not executed."],
        relationshipCoverage: { status: "complete" },
        locations: [{ kind: "artifact-path", path: "src/app-client.js" }],
        evidenceLinks: [],
      },
    );

    expect(extractStructuredFindingsFromEvidence(evidence1)).toHaveLength(2);

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-DANGLING",
            rule_id: "rea/network/test",
            category: "network",
            message: "Test dangling ref",
            evidence_ids: [EV_ID_DANGLING],
          },
        ],
        evidence_records: [evidence1],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "dangling_evidence_reference",
        findingId: "F-DANGLING",
      }),
    );

    const exportedSingle = exportEvidenceToSarif(evidence1);
    expect(exportedSingle.runs[0]?.results).toHaveLength(2);
    expect(exportedSingle.runs[0]?.properties.rea_source_evidence_ids).toEqual([
      evidence1.evidence_id,
    ]);

    const residualUnknown = createResidualUnknown(
      recordUnknownInputSchema.parse({
        question: "Is the fallback token rotated at runtime?",
        severity: "medium",
        domain: "authentication",
        supporting_evidence_ids: [evidence1.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
      evidence1.evidence_id,
      ARTIFACT_SHA_1,
    );
    const bundle = createEvidenceBundle([evidence1], [residualUnknown]);
    const bundleExportResult = tryExportEvidenceBundleToSarif(bundle);
    expect(bundleExportResult.ok).toBe(true);
    if (bundleExportResult.ok) {
      expect(
        bundleExportResult.value.runs[0]?.properties.rea_limitations.some(
          (note) => note.includes("1 residual unknown record(s)"),
        ),
      ).toBe(true);
    }

    const unsupportedEvidence = createEvidence(
      undefined,
      { id: "rea-disasm", name: "REA Disassembler", version: "6.8.0" },
      {
        predicateType: "rea.binary.disassembly.v1",
        operation: "disassemble_procedure",
        parameters: {},
        rawResult: null,
        result: {
          analysis_category: "raw-disassembly-dump",
          instructions: ["push rbp", "mov rbp, rsp"],
        },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const unsupportedRes = tryExportEvidenceToSarif(unsupportedEvidence);
    expect(unsupportedRes.ok).toBe(false);

    const tampered = JSON.parse(serializeSarifLog(exportedSingle)) as {
      runs: { results: Record<string, unknown>[] }[];
    };
    const firstResult = tampered.runs[0]?.results[0];
    if (firstResult !== undefined) {
      firstResult.message = { text: "Tampered message text" };
    }
    expect(() => parseSarifLog(tampered)).toThrowError(
      expect.objectContaining({ code: "sarif_integrity_failed" }),
    );

    const tempDir = await mkdtemp(join(tmpdir(), "rea-sarif-test-"));
    try {
      const outPath = join(tempDir, "findings.sarif.json");
      const bundleLog = exportEvidenceBundleToSarif(bundle);
      await writeSarifLogFile(outPath, bundleLog);
      const diskText = await readFile(outPath, "utf8");
      expect(parseSarifLog(JSON.parse(diskText))).toEqual(bundleLog);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
