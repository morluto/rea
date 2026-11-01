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

describe("SARIF 2.1.0 adversarial rule, region, and URI guards (#6332)", () => {
  it("rejects conflicting rule metadata and preserves permutation-invariant rule defaults", () => {
    const ev1 = `ev_${"1".repeat(64)}`;
    const ev2 = `ev_${"2".repeat(64)}`;
    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-1",
            rule_id: "rea/crypto/r1",
            rule_short_description: "Desc A",
            category: "crypto",
            message: "One",
            evidence_ids: [ev1],
          },
          {
            finding_id: "F-2",
            rule_id: "rea/crypto/r1",
            rule_short_description: "Desc B",
            category: "crypto",
            message: "Two",
            evidence_ids: [ev2],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_rule_id" }));

    const orderA = exportFindingsToSarif({
      findings: [
        {
          finding_id: "F-B",
          rule_id: "rea/crypto/shared",
          category: "crypto",
          severity: "low",
          title: "Fallback title B",
          message: "Low severity instance",
          evidence_ids: [ev1],
        },
        {
          finding_id: "F-A",
          rule_id: "rea/crypto/shared",
          rule_short_description: "Explicit rule short description",
          category: "crypto",
          severity: "critical",
          title: "Fallback title A",
          message: "Critical severity instance",
          locations: [{ uri: "src/a.c" }, { uri: "src/b.c" }],
          artifact_sha256: ARTIFACT_SHA_1,
          evidence_ids: [ev2],
        },
      ],
    });
    const orderB = exportFindingsToSarif({
      findings: [
        {
          finding_id: "F-A",
          rule_id: "rea/crypto/shared",
          rule_short_description: "Explicit rule short description",
          category: "crypto",
          severity: "critical",
          title: "Fallback title A",
          message: "Critical severity instance",
          locations: [{ uri: "src/b.c" }, { uri: "src/a.c" }],
          artifact_sha256: ARTIFACT_SHA_1,
          evidence_ids: [ev2],
        },
        {
          finding_id: "F-B",
          rule_id: "rea/crypto/shared",
          category: "crypto",
          severity: "low",
          title: "Fallback title B",
          message: "Low severity instance",
          evidence_ids: [ev1],
        },
      ],
    });
    expect(serializeSarifLog(orderA)).toBe(serializeSarifLog(orderB));
    const rule = orderA.runs[0]?.tool.driver.rules[0];
    expect(rule?.defaultConfiguration?.level).toBe("error");
    expect(rule?.shortDescription.text).toBe("Explicit rule short description");
    // Multi-URI finding must not bind single artifact_sha256 to both distinct URIs
    expect(orderA.runs[0]?.artifacts.every((a) => a.hashes === undefined)).toBe(
      true,
    );
  });

  it("enforces SARIF 2.1.0 region invariants and path segment bounds", () => {
    const ev1 = `ev_${"1".repeat(64)}`;
    const invalidLocations = [
      { uri: "src/a.c", startColumn: 4 },
      { uri: "src/a.c", endLine: 10 },
      { uri: "src/a.c", startLine: 5, endColumn: 3 },
      {
        uri: "src/a.c",
        startLine: 5,
        startColumn: 8,
        endLine: 5,
        endColumn: 3,
      },
      { uri: "bin/a.bin", byteLength: 16 },
      { uri: "bin/a.bin", byteOffset: 0, byteLength: 0 },
    ];
    for (const loc of invalidLocations) {
      expect(() =>
        exportFindingsToSarif({
          findings: [
            {
              finding_id: "F-BAD-REG",
              rule_id: "rea/ipc/r1",
              category: "ipc",
              message: "Bad region",
              locations: [loc],
              evidence_ids: [ev1],
            },
          ],
        }),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_location_metadata" }),
      );
    }

    const badUris = [
      `src/${"é".repeat(128)}.js`,
      "src/CON.txt",
      "src/bad\u0000.js",
      "src/surrogate\uD800.js",
    ];
    for (const badUri of badUris) {
      expect(() =>
        exportFindingsToSarif({
          artifacts: [{ uri: badUri, sha256: ARTIFACT_SHA_1 }],
          findings: [],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_artifact_uri" }));
    }
  });
});

describe("SarifExportService fail-closed validation and prototype-key safety (#6332)", () => {
  it("rejects malformed Evidence finding fields and ignores Object.prototype URI map keys", () => {
    const makeEv = (findingOverride: Record<string, unknown>) =>
      createEvidence(
        { path: "/tmp/bin.elf", sha256: ARTIFACT_SHA_1, format: "elf" },
        { id: "rea-elf", name: "REA ELF", version: "6.8.0" },
        {
          predicateType: "rea.binary.findings.v1",
          operation: "analyze_binary",
          parameters: {},
          rawResult: null,
          result: {
            findings: [
              {
                finding_id: "F-1",
                category: "crypto",
                message: "Weak key",
                ...findingOverride,
              },
            ],
          },
          confidence: "observed",
          authority: "shipped-artifact",
        },
      );

    expect(() =>
      extractStructuredFindingsFromEvidence(makeEv({ confidence: "guessed" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_finding_input" }));
    expect(() =>
      extractStructuredFindingsFromEvidence(makeEv({ status: "bogus" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_finding_input" }));
    expect(() =>
      extractStructuredFindingsFromEvidence(makeEv({ severity: 123 })),
    ).toThrowError(expect.objectContaining({ code: "invalid_severity" }));
    expect(() =>
      extractStructuredFindingsFromEvidence(
        makeEv({ evidence_ids: "not-an-array" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_evidence_reference" }),
    );
    expect(() =>
      extractStructuredFindingsFromEvidence(makeEv({ attributes: ["bad"] })),
    ).toThrowError(expect.objectContaining({ code: "invalid_finding_input" }));

    const validEv = makeEv({
      attributes: JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":"safe"}',
      ) as Record<string, unknown>,
    });
    const bundle = createEvidenceBundle([validEv], []);
    const log = exportEvidenceBundleToSarif(bundle, {
      defaultArtifactUriBySha256: {},
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(log.runs[0]?.results[0]?.properties.rea_finding_id).toBe("F-1");
  });
});

const buildGroup2ApkEvidence = (apkSha: string) =>
  createEvidence(
    {
      path: "/samples/payment.apk",
      sha256: apkSha,
      format: "apk",
      architecture: "arm64",
    },
    {
      id: "rea-android-manifest",
      name: "REA Android Analyzer",
      version: "6.8.0",
    },
    {
      predicateType: "rea.android.findings.v1",
      operation: "analyze_android_application",
      parameters: {},
      rawResult: null,
      result: {
        findings: [
          {
            finding_id: "APK-IPC-01",
            rule_id: "rea/exported-component/unprotected-activity",
            category: "manifest-misconfiguration",
            severity: "high",
            confidence: "observed",
            title: "Exported deep-link activity without permission guard",
            summary:
              "DeepLinkPayActivity is exported without android:permission.",
            locations: [
              {
                uri: "AndroidManifest.xml",
                startLine: 44,
                startColumn: 5,
                endLine: 52,
                endColumn: 16,
              },
            ],
          },
          {
            finding_id: "APK-WEBVIEW-02",
            rule_id: "rea/webview/js-interface",
            category: "ipc",
            severity: "critical",
            confidence: "observed",
            summary:
              "addJavascriptInterface bridges NativeWallet to untrusted web frames.",
          },
        ],
      },
      confidence: "observed",
      authority: "shipped-artifact",
      environment: null,
      limitations: ["ProGuard mapping file not supplied."],
      relationshipCoverage: {
        status: "partial",
        limitations: ["Dynamic BroadcastReceiver registrations omitted."],
      },
      locations: [
        { kind: "file-offset-range", start: 4096, end: 4160 },
        { kind: "address", address: "0x00401000" },
      ],
      evidenceLinks: [],
    },
  );

const buildGroup2JniEvidence = (jniSha: string) =>
  createEvidence(
    {
      path: "/samples/libwallet_jni.so",
      sha256: jniSha,
      format: "elf",
      architecture: "arm64",
    },
    { id: "rea-ghidra-headless", name: "REA Ghidra Bridge", version: "6.8.0" },
    {
      predicateType: "rea.binary.findings.v1",
      operation: "analyze_native_jni",
      parameters: {},
      rawResult: null,
      result: {
        findings: [
          {
            finding_id: "JNI-BRIDGE-01",
            rule_id: "rea/native-bridge/unchecked-memcpy",
            category: "unsafe-api-usage",
            severity: "high",
            confidence: "inferred",
            status: "inferred",
            summary:
              "JNI GetByteArrayElements copied into fixed stack buffer without length check.",
            locations: [
              {
                address: "0x00102040",
                addressLengthBytes: 20,
                logicalName: "Java_com_pay_NativeWallet_sign",
                logicalKind: "function",
              },
            ],
          },
        ],
      },
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations: [],
      relationshipCoverage: {
        status: "unknown",
        reason:
          "Indirect RegisterNatives table computed via runtime init_array.",
      },
      locations: [],
      evidenceLinks: [],
    },
  );

describe("multi-dataset Ingression, Review, and Reproduction Coverage (#6332)", () => {
  it("ingests multi-provider APK + JNI EvidenceBundle with partial coverage and reproduces deterministically", () => {
    const apkSha = "b".repeat(64);
    const jniSha = "c".repeat(64);
    const apkEvidence = buildGroup2ApkEvidence(apkSha);
    const jniEvidence = buildGroup2JniEvidence(jniSha);

    const bundleForward = createEvidenceBundle([apkEvidence, jniEvidence], []);
    const bundleReverse = createEvidenceBundle([jniEvidence, apkEvidence], []);
    const uriMap = {
      [apkSha]: "artifacts/payment.apk",
      [jniSha]: "lib/arm64-v8a/libwallet_jni.so",
    };

    const sarifA = exportEvidenceBundleToSarif(bundleForward, {
      defaultArtifactUriBySha256: uriMap,
    });
    const sarifB = exportEvidenceBundleToSarif(bundleReverse, {
      defaultArtifactUriBySha256: uriMap,
    });
    const jsonA = serializeSarifLog(sarifA);
    expect(serializeSarifLog(sarifB)).toBe(jsonA);

    const reparsed = parseSarifLog(JSON.parse(jsonA));
    expect(reparsed.runs[0]?.properties.rea_provider_id).toBeNull();
    const lims = reparsed.runs[0]?.properties.rea_limitations ?? [];
    expect(
      lims.some((l) => l.includes("recorded partial relationship coverage.")),
    ).toBe(true);
    expect(
      lims.some((l) =>
        l.includes("Dynamic BroadcastReceiver registrations omitted."),
      ),
    ).toBe(true);
    expect(
      lims.some((l) =>
        l.includes(
          "relationship coverage is unknown: Indirect RegisterNatives",
        ),
      ),
    ).toBe(true);

    expect(() =>
      exportFindingsToSarif({
        findings: [
          {
            finding_id: "F-SHA-CONFLICT",
            rule_id: "rea/crypto/r1",
            category: "crypto",
            message: "Mismatched artifact sha",
            artifact_sha256: ARTIFACT_SHA_1,
            evidence_ids: [apkEvidence.evidence_id],
          },
        ],
        evidence_records: [apkEvidence],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_artifact_uri" }));
  });
});
