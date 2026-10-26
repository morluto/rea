import { describe, expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import {
  convertEvidenceLocationToSarifLocationInput,
  describeSarifCategorySupport,
  exportFindingsToSarif,
  isSupportedSarifFindingCategory,
  isUnsupportedSarifAnalysisCategory,
  mapReaSeverityToSarifLevel,
  normalizeSarifArtifactUri,
  parseSarifLog,
  SARIF_CATEGORY_SUPPORT_MATRIX,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  SarifExportError,
  serializeSarifLog,
  SUPPORTED_SARIF_FINDING_CATEGORIES,
  tryExportFindingsToSarif,
  UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
} from "./sarifExport.js";

const EV_ID_1 = `ev_${"1".repeat(64)}`;
const EV_ID_2 = `ev_${"2".repeat(64)}`;
const EV_ID_DANGLING = `ev_${"9".repeat(64)}`;
const ARTIFACT_SHA_1 = "a".repeat(64);
const ARTIFACT_SHA_2 = "b".repeat(64);
const PROFILE_SHA = "c".repeat(64);

describe("SARIF 2.1.0 category support matrix (#6332)", () => {
  it("exposes programmatic supported and unsupported category descriptors", () => {
    expect(SUPPORTED_SARIF_FINDING_CATEGORIES.length).toBeGreaterThanOrEqual(
      10,
    );
    expect(UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES).toContain(
      "raw-disassembly-dump",
    );
    expect(UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES).toContain(
      "decompiled-pseudocode-listing",
    );
    expect(UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES).toContain(
      "residual-unknown-question",
    );

    expect(isSupportedSarifFindingCategory("hardcoded-secret")).toBe(true);
    expect(isSupportedSarifFindingCategory("raw-disassembly-dump")).toBe(false);
    expect(isUnsupportedSarifAnalysisCategory("raw-disassembly-dump")).toBe(
      true,
    );

    expect(describeSarifCategorySupport("network-exposure")).toEqual({
      category: "network-exposure",
      supported: true,
      classification: "supported_finding_category",
      explanation: expect.any(String),
    });

    expect(describeSarifCategorySupport("control-flow-graph-topology")).toEqual(
      {
        category: "control-flow-graph-topology",
        supported: false,
        classification: "known_unsupported_analysis_category",
        explanation: expect.stringContaining("structural graph"),
      },
    );

    const unknownDesc = describeSarifCategorySupport("custom-unmapped-kind");
    expect(unknownDesc.supported).toBe(false);
    expect(unknownDesc.classification).toBe("unrecognized_category");

    expect(SARIF_CATEGORY_SUPPORT_MATRIX).toHaveLength(
      SUPPORTED_SARIF_FINDING_CATEGORIES.length +
        UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES.length,
    );
  });
});

describe("SARIF 2.1.0 location and severity fidelity (#6332)", () => {
  it("exports complete, partial, and unavailable locations without fabricating fields", () => {
    const log = exportFindingsToSarif({
      tool: { name: "rea", version: "6.8.0" },
      provider: {
        id: "ghidra-headless",
        name: "Ghidra Headless",
        version: "11.2.1",
      },
      analysis_profile_digest: PROFILE_SHA,
      artifacts: [
        {
          uri: "src/net/client.js",
          sha256: ARTIFACT_SHA_1,
          bytes: 4096,
          sourceLanguage: "javascript",
        },
        {
          uri: "bin/daemon.elf",
          sha256: ARTIFACT_SHA_2,
          bytes: 65536,
          format: "elf",
          architecture: "x86_64",
        },
      ],
      findings: [
        {
          finding_id: "F-COMPLETE",
          rule_id: "rea/network-exposure/cleartext-endpoint",
          category: "network-exposure",
          severity: "high",
          confidence: "observed",
          authority: "shipped-artifact",
          status: "observed",
          message: "Uses unencrypted http://api.example.com/v1/login.",
          locations: [
            {
              uri: "src/net/client.js",
              startLine: 42,
              startColumn: 9,
              endLine: 42,
              endColumn: 48,
              snippetText: 'fetch("http://api.example.com/v1/login")',
              logicalName: "authenticateClient",
              logicalKind: "function",
            },
          ],
          evidence_ids: [EV_ID_2, EV_ID_1, EV_ID_1],
          artifact_sha256: ARTIFACT_SHA_1,
        },
        {
          finding_id: "F-PARTIAL-ADDRESS",
          rule_id: "rea/unsafe-api-usage/strcpy-call",
          category: "unsafe-api-usage",
          severity: "medium",
          message: "Unbounded strcpy call without source line table.",
          locations: [
            {
              uri: "bin/daemon.elf",
              address: "0x004012a0",
              addressLengthBytes: 5,
              logicalName: "parse_packet",
              logicalKind: "function",
            },
          ],
          evidence_ids: [EV_ID_1],
          artifact_sha256: ARTIFACT_SHA_2,
        },
        {
          finding_id: "F-UNAVAILABLE",
          rule_id: "rea/entitlement-privilege/debuggable-flag",
          category: "entitlement-privilege",
          severity: null,
          message: "Package entitlement permits attachment.",
          locations: [],
          evidence_ids: [EV_ID_1],
          artifact_sha256: ARTIFACT_SHA_2,
        },
      ],
    });

    expect(log.$schema).toBe(SARIF_SCHEMA_URI);
    expect(log.version).toBe(SARIF_VERSION);
    const run = log.runs[0];
    expect(run?.tool.driver.rules.map((r) => r.id)).toEqual([
      "rea/entitlement-privilege/debuggable-flag",
      "rea/network-exposure/cleartext-endpoint",
      "rea/unsafe-api-usage/strcpy-call",
    ]);
    expect(run?.artifacts.map((a) => a.location.uri)).toEqual([
      "bin/daemon.elf",
      "src/net/client.js",
    ]);

    const [unavailRes, completeRes, partialRes] = run?.results ?? [];
    expect("level" in (unavailRes ?? {})).toBe(false);
    expect(unavailRes?.locations).toEqual([]);
    expect(unavailRes?.properties.location_availability).toBe("unavailable");
    expect(unavailRes?.properties.missing_location_fields).toEqual([
      "uri",
      "region",
      "logicalLocation",
    ]);

    expect(completeRes?.level).toBe("error");
    expect(completeRes?.properties.location_availability).toBe("complete");
    expect(completeRes?.properties.rea_evidence_ids).toEqual([
      EV_ID_1,
      EV_ID_2,
    ]);

    expect(partialRes?.level).toBe("warning");
    expect(partialRes?.properties.location_availability).toBe("partial");
    expect(partialRes?.locations[0]?.physicalLocation?.region).toBeUndefined();
    expect(partialRes?.locations[0]?.physicalLocation?.address).toEqual({
      fullyQualifiedName: "0x004012a0",
      absoluteAddress: 0x004012a0,
      length: 5,
    });
    expect(parseSarifLog(JSON.parse(serializeSarifLog(log)))).toEqual(log);
  });
});

describe("SARIF 2.1.0 fail-closed validation (#6332)", () => {
  it("rejects unsupported categories, missing evidence, and malformed rules or severity", () => {
    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-DISASM-1",
            rule_id: "rea/disasm/listing",
            category: "raw-disassembly-dump",
            message: "Full text section disassembly listing",
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "SarifExportError",
        code: "unsupported_finding_category",
        findingId: "F-DISASM-1",
        category: "raw-disassembly-dump",
      }),
    );

    const unknownCatResult = tryExportFindingsToSarif({
      findings: [
        {
          finding_id: "F-UNKNOWN-CAT",
          rule_id: "rea/unknown/x",
          category: "non-existent-category",
          message: "Some observation",
          evidence_ids: [EV_ID_1],
        },
      ],
    });
    expect(unknownCatResult.ok).toBe(false);
    if (!unknownCatResult.ok) {
      expect(unknownCatResult.error).toBeInstanceOf(SarifExportError);
      expect(unknownCatResult.error.code).toBe("unsupported_finding_category");
    }

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-NO-EVIDENCE",
            rule_id: "rea/crypto/weak-md5",
            category: "cryptographic-weakness",
            message: "MD5 digest used",
            evidence_ids: [],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "missing_evidence_reference",
        findingId: "F-NO-EVIDENCE",
      }),
    );

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-EMPTY-RULE",
            rule_id: "   ",
            category: "cryptographic-weakness",
            message: "MD5 digest used",
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_rule_id",
        findingId: "F-EMPTY-RULE",
      }),
    );

    expect(() =>
      mapReaSeverityToSarifLevel("super-urgent", "F-BAD-SEV"),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_severity",
        findingId: "F-BAD-SEV",
      }),
    );
  });

  it("rejects malformed location coordinates and unsafe artifact URIs", () => {
    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-BAD-COL",
            rule_id: "rea/crypto/weak-md5",
            category: "cryptographic-weakness",
            message: "MD5 digest used",
            locations: [{ uri: "src/index.js", startColumn: 5 }],
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_location_metadata",
        findingId: "F-BAD-COL",
      }),
    );

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-TRAVERSAL-URI",
            rule_id: "rea/crypto/weak-md5",
            category: "cryptographic-weakness",
            message: "MD5 digest used",
            locations: [{ uri: "../outside/secret.js", startLine: 10 }],
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_artifact_uri",
        findingId: "F-TRAVERSAL-URI",
      }),
    );

    expect(normalizeSarifArtifactUri("https://evil.example/a.js").ok).toBe(
      false,
    );
    expect(normalizeSarifArtifactUri("a\\b\\c.js").ok).toBe(false);
    expect(normalizeSarifArtifactUri("/src/app.js")).toEqual({
      ok: true,
      value: "src/app.js",
    });
    expect(
      convertEvidenceLocationToSarifLocationInput(
        { kind: "file-offset-range", start: 128, end: 160 },
        "bin/app.bin",
      ),
    ).toEqual({
      uri: "bin/app.bin",
      byteOffset: 128,
      byteLength: 32,
    });
  });
});

describe("SARIF 2.1.0 Evidence record cross-checking and integrity (#6332)", () => {
  it("verifies evidence_ids against supplied Evidence records and detects tampered SARIF runs", () => {
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
        result: { findings: [] },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );

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

    const validLog = exportFindingsToSarif({
      findings: [
        {
          finding_id: "F-LINKED",
          rule_id: "rea/network/test",
          category: "network",
          message: "Linked to verified evidence1",
          evidence_ids: [evidence1.evidence_id],
        },
      ],
      evidence_records: [evidence1],
    });
    expect(validLog.runs[0]?.results[0]?.properties.rea_artifact_sha256).toBe(
      ARTIFACT_SHA_1,
    );

    const tampered = JSON.parse(serializeSarifLog(validLog)) as {
      runs: { results: Record<string, unknown>[] }[];
    };
    const firstResult = tampered.runs[0]?.results[0];
    if (firstResult !== undefined) {
      firstResult.message = { text: "Tampered message text" };
    }
    expect(() => parseSarifLog(tampered)).toThrowError(
      expect.objectContaining({ code: "sarif_integrity_failed" }),
    );
  });
});

describe("SARIF 2.1.0 partial location variants and edge-case guards (#6332)", () => {
  it("distinguishes URI-only, symbol-only, and byte-offset-only partial locations", () => {
    const log = exportFindingsToSarif({
      findings: [
        {
          finding_id: "F-URI-ONLY",
          rule_id: "rea/permissions/broad-permission",
          category: "permissions",
          message: "Manifest requests broad read access.",
          locations: [{ uri: "AndroidManifest.xml" }],
          evidence_ids: [EV_ID_1],
        },
        {
          finding_id: "F-SYMBOL-ONLY",
          rule_id: "rea/crypto/custom-cipher",
          category: "crypto",
          message: "Symbol implements custom XOR stream cipher.",
          locations: [
            {
              logicalName: "crypto::xor_stream_decrypt",
              logicalKind: "function",
            },
          ],
          evidence_ids: [EV_ID_1],
        },
        {
          finding_id: "F-BYTE-OFFSET-ONLY",
          rule_id: "rea/integrity-violation/header-patch",
          category: "integrity-violation",
          message: "Section header flags modified at binary offset.",
          locations: [
            {
              uri: "bin/firmware.bin",
              byteOffset: 512,
              byteLength: 16,
            },
          ],
          evidence_ids: [EV_ID_1],
        },
      ],
    });

    const resultsById = new Map(
      log.runs[0]?.results.map((r) => [r.properties.rea_finding_id, r]),
    );

    const uriOnly = resultsById.get("F-URI-ONLY");
    expect(uriOnly?.properties.location_availability).toBe("partial");
    expect(uriOnly?.properties.missing_location_fields).toEqual([
      "region",
      "startLine",
    ]);
    expect(uriOnly?.locations[0]?.physicalLocation?.region).toBeUndefined();

    const symbolOnly = resultsById.get("F-SYMBOL-ONLY");
    expect(symbolOnly?.properties.location_availability).toBe("partial");
    expect(symbolOnly?.properties.missing_location_fields).toEqual([
      "uri",
      "region",
      "startLine",
    ]);
    expect(symbolOnly?.locations[0]?.physicalLocation).toBeUndefined();
    expect(symbolOnly?.locations[0]?.logicalLocations?.[0]?.name).toBe(
      "crypto::xor_stream_decrypt",
    );

    const byteOnly = resultsById.get("F-BYTE-OFFSET-ONLY");
    expect(byteOnly?.properties.location_availability).toBe("partial");
    expect(byteOnly?.properties.missing_location_fields).toEqual(["startLine"]);
    expect(byteOnly?.locations[0]?.physicalLocation?.region).toEqual({
      byteOffset: 512,
      byteLength: 16,
    });
  });

  it("rejects duplicate finding IDs, conflicting artifact digests, and non-positive lines", () => {
    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-DUP",
            rule_id: "rea/ipc/exposed",
            category: "ipc",
            message: "First",
            evidence_ids: [EV_ID_1],
          },
          {
            finding_id: "F-DUP",
            rule_id: "rea/ipc/exposed",
            category: "ipc",
            message: "Second",
            evidence_ids: [EV_ID_2],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_finding_input",
        findingId: "F-DUP",
      }),
    );

    expect(() =>
      exportFindingsToSarif({
        artifacts: [
          { uri: "bin/a.elf", sha256: ARTIFACT_SHA_1 },
          { uri: "bin/a.elf", sha256: ARTIFACT_SHA_2 },
        ],
        findings: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_artifact_uri",
      }),
    );

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-ZERO-LINE",
            rule_id: "rea/ipc/exposed",
            category: "ipc",
            message: "Invalid line 0",
            locations: [{ uri: "src/a.js", startLine: 0 }],
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_location_metadata",
        findingId: "F-ZERO-LINE",
      }),
    );

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-NEG-OFFSET",
            rule_id: "rea/ipc/exposed",
            category: "ipc",
            message: "Invalid negative byteOffset",
            locations: [{ uri: "bin/a.bin", byteOffset: -1 }],
            evidence_ids: [EV_ID_1],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_location_metadata",
        findingId: "F-NEG-OFFSET",
      }),
    );
  });
});
