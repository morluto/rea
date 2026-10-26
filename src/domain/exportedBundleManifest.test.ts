import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EvidenceIntegrityError } from "./evidenceErrors.js";
import {
  createExportedBundleManifest,
  EXPORTED_BUNDLE_MANIFEST_FILENAME,
  EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION,
  EXPORTED_BUNDLE_MANIFEST_VERSION,
  normalizeExportedBundleRelativePath,
  parseExportedBundleManifest,
  serializeExportedBundleManifest,
  verifyExportedBundleManifest,
} from "./exportedBundleManifest.js";

const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const ARTIFACT_SHA256 = "a".repeat(64);
const PROFILE_SHA256 = "b".repeat(64);
const EVIDENCE_ID_1 = `ev_${"1".repeat(64)}`;
const EVIDENCE_ID_2 = `ev_${"2".repeat(64)}`;

describe("exportedBundleManifest creation and canonical round-trip (#6337)", () => {
  it("creates, serializes, parses, and verifies a canonical bundle manifest", () => {
    const indexJson = '{"version":1,"functions":[]}\n';
    const fnC = "int main(void) { return 0; }\n";

    const manifest = createExportedBundleManifest({
      bundle_kind: "decompile-directory",
      entries: [
        {
          relative_path: "functions/00001000_main.c",
          sha256: sha256Text(fnC),
          bytes: Buffer.byteLength(fnC),
          role: "decompiled-function",
        },
        {
          relative_path: "index.json",
          sha256: sha256Text(indexJson),
          bytes: Buffer.byteLength(indexJson),
          role: "index",
        },
      ],
      provenance: {
        artifact: {
          available: true,
          sha256: ARTIFACT_SHA256,
          format: "elf",
          architecture: "x86_64",
        },
        provider: {
          available: true,
          id: "ghidra",
          name: "Ghidra",
          version: "11.2",
        },
        analysis_profile: {
          available: true,
          digest: PROFILE_SHA256,
        },
        source_evidence_ids: [EVIDENCE_ID_2, EVIDENCE_ID_1, EVIDENCE_ID_1],
      },
    });

    expect(manifest.schema_version).toBe(EXPORTED_BUNDLE_MANIFEST_VERSION);
    expect(manifest.summary).toEqual({
      file_count: 2,
      total_bytes: Buffer.byteLength(indexJson) + Buffer.byteLength(fnC),
    });
    expect(manifest.provenance.source_evidence_ids).toEqual([
      EVIDENCE_ID_1,
      EVIDENCE_ID_2,
    ]);
    expect(manifest.limitations).toContain(
      EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION,
    );

    const serialized = serializeExportedBundleManifest(manifest);
    const parsed = parseExportedBundleManifest(JSON.parse(serialized));
    expect(parsed).toEqual(manifest);

    const report = verifyExportedBundleManifest(parsed, [
      {
        relative_path: "index.json",
        kind: "file",
        sha256: sha256Text(indexJson),
        bytes: Buffer.byteLength(indexJson),
      },
      {
        relative_path: "functions/00001000_main.c",
        kind: "file",
        sha256: sha256Text(fnC),
        bytes: Buffer.byteLength(fnC),
      },
    ]);

    expect(report.verified).toBe(true);
    expect(report.status).toBe("verified");
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({
      expected_files: 2,
      observed_files: 2,
      verified_files: 2,
      missing_files: 0,
      modified_files: 0,
      unexpected_files: 0,
      invalid_entries: 0,
    });
  });

  it("keeps unavailable provenance fields explicit and produces permutation-invariant digests", () => {
    const fileA = {
      relative_path: "a/alpha.json",
      sha256: sha256Text("alpha"),
      bytes: 5,
    };
    const fileB = {
      relative_path: "b/beta.json",
      sha256: sha256Text("beta"),
      bytes: 4,
    };

    const first = createExportedBundleManifest({
      bundle_kind: "analysis-bundle",
      entries: [fileB, fileA],
    });
    const second = createExportedBundleManifest({
      bundle_kind: "analysis-bundle",
      entries: [fileA, fileB],
    });

    expect(first.manifest_sha256).toBe(second.manifest_sha256);
    expect(serializeExportedBundleManifest(first)).toBe(
      serializeExportedBundleManifest(second),
    );
    expect(first.provenance).toEqual({
      artifact: {
        available: false,
        reason: "Artifact identity was not provided at bundle export time.",
      },
      provider: {
        available: false,
        reason: "Provider metadata was not provided at bundle export time.",
      },
      analysis_profile: {
        available: false,
        reason:
          "Analysis profile commitment was not provided at bundle export time.",
      },
      source_evidence_ids: [],
    });
  });
});

describe("exportedBundleManifest tamper and reconciliation detection (#6337)", () => {
  it("detects modified files, missing files, unexpected extra files, and tampered manifests", () => {
    const fileA = "alpha-content";
    const fileB = "beta-content";
    const manifest = createExportedBundleManifest({
      bundle_kind: "analysis-bundle",
      entries: [
        {
          relative_path: "alpha.txt",
          sha256: sha256Text(fileA),
          bytes: Buffer.byteLength(fileA),
        },
        {
          relative_path: "beta.txt",
          sha256: sha256Text(fileB),
          bytes: Buffer.byteLength(fileB),
        },
      ],
    });

    const tamperedA = "alpha-tampered!";
    const extraFile = "unexpected-payload";
    const report = verifyExportedBundleManifest(manifest, [
      {
        relative_path: "alpha.txt",
        kind: "file",
        sha256: sha256Text(tamperedA),
        bytes: Buffer.byteLength(tamperedA),
      },
      {
        relative_path: "extra.txt",
        kind: "file",
        sha256: sha256Text(extraFile),
        bytes: Buffer.byteLength(extraFile),
      },
    ]);

    expect(report.verified).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.summary).toEqual({
      expected_files: 2,
      observed_files: 2,
      verified_files: 0,
      missing_files: 1,
      modified_files: 1,
      unexpected_files: 1,
      invalid_entries: 0,
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "digest_mismatch",
      "size_mismatch",
      "missing_file",
      "unexpected_file",
    ]);

    const tamperedManifest = {
      ...manifest,
      entries: [{ ...manifest.entries[0]!, sha256: "f".repeat(64) }],
    };
    expect(() => parseExportedBundleManifest(tamperedManifest)).toThrow(
      EvidenceIntegrityError,
    );
    const badManifestReport = verifyExportedBundleManifest(tamperedManifest, [
      {
        relative_path: "alpha.txt",
        kind: "file",
        sha256: "f".repeat(64),
        bytes: Buffer.byteLength(fileA),
      },
      {
        relative_path: "../bad.txt",
        kind: "file",
        sha256: "f".repeat(64),
        bytes: 4,
      },
    ]);
    expect(badManifestReport.verified).toBe(false);
    expect(badManifestReport.status).toBe("invalid_manifest");
    expect(badManifestReport.summary.observed_files).toBe(1);
    expect(badManifestReport.findings.map((f) => f.kind)).toContain(
      "manifest_integrity_failed",
    );
  });
});

describe("exportedBundleManifest adversarial path and case-collision traps (#6337)", () => {
  it("rejects traversal, >255-byte UTF-8 segments, Windows device names, lone surrogates, and case collisions", () => {
    const over255Utf8Segment = `${"\u00e9".repeat(128)}.json`; // 128 * 2 + 5 = 261 UTF-8 bytes, 133 UTF-16 units
    const invalidPaths = [
      "",
      "../secret.txt",
      "a/../b.txt",
      "./a.txt",
      "/absolute/path.txt",
      "trailing/",
      "a//b.txt",
      "dir\\backslash.txt",
      "C:/windows/system32",
      "file:///etc/passwd",
      "encoded/%2e%2e/escape.txt",
      "nul\0byte.txt",
      "control\u0007bell.txt",
      "lone\uD800surrogate.txt",
      over255Utf8Segment,
      "dir/CON.txt",
      "dir/lpt1.json",
      "dir/trailingdot.",
      "dir/trailingspace ",
      EXPORTED_BUNDLE_MANIFEST_FILENAME,
      "REA-BUNDLE-MANIFEST.JSON",
      `.${EXPORTED_BUNDLE_MANIFEST_FILENAME}.tmp-123`,
    ];

    for (const invalidPath of invalidPaths) {
      expect(normalizeExportedBundleRelativePath(invalidPath).ok).toBe(false);
      expect(() =>
        createExportedBundleManifest({
          bundle_kind: "analysis-bundle",
          entries: [
            {
              relative_path: invalidPath,
              sha256: "a".repeat(64),
              bytes: 10,
            },
          ],
        }),
      ).toThrow(EvidenceIntegrityError);
    }

    // Reject duplicate or case-colliding entries (including Unicode ß vs SS)
    expect(() =>
      createExportedBundleManifest({
        bundle_kind: "analysis-bundle",
        entries: [
          { relative_path: "Report.json", sha256: "a".repeat(64), bytes: 2 },
          { relative_path: "report.json", sha256: "b".repeat(64), bytes: 2 },
        ],
      }),
    ).toThrow(EvidenceIntegrityError);

    expect(() =>
      createExportedBundleManifest({
        bundle_kind: "analysis-bundle",
        entries: [
          {
            relative_path: "stra\u00dfe.json",
            sha256: "a".repeat(64),
            bytes: 2,
          },
          { relative_path: "STRASSE.JSON", sha256: "b".repeat(64), bytes: 2 },
        ],
      }),
    ).toThrow(EvidenceIntegrityError);

    // Reject case-insensitive directory prefix conflicts
    expect(() =>
      createExportedBundleManifest({
        bundle_kind: "analysis-bundle",
        entries: [
          { relative_path: "Nested/item", sha256: "a".repeat(64), bytes: 4 },
          {
            relative_path: "nested/item/child.json",
            sha256: "b".repeat(64),
            bytes: 4,
          },
        ],
      }),
    ).toThrow(EvidenceIntegrityError);

    // Observed case-colliding paths fail closed during verification
    const validManifest = createExportedBundleManifest({
      bundle_kind: "analysis-bundle",
      entries: [
        {
          relative_path: "safe/entry.json",
          sha256: sha256Text("{}"),
          bytes: 2,
        },
      ],
    });
    const collisionReport = verifyExportedBundleManifest(validManifest, [
      {
        relative_path: "safe/entry.json",
        kind: "file",
        sha256: sha256Text("{}"),
        bytes: 2,
      },
      {
        relative_path: "SAFE/ENTRY.JSON",
        kind: "file",
        sha256: sha256Text("{}"),
        bytes: 2,
      },
    ]);
    expect(collisionReport.verified).toBe(false);
    expect(collisionReport.findings).toEqual([
      expect.objectContaining({
        kind: "duplicate_observed_path",
        relative_path: "SAFE/ENTRY.JSON",
      }),
    ]);
  });
});
