import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { warcArchiveSchema } from "../../domain/warcArchive/warcArchive.js";
import { inspectWarcArchiveEvidence } from "./WarcArchiveService.js";

const PAYLOAD = "HTTP/1.1 200 OK\r\n\r\nbody";
const RECORD = `WARC/1.1\r\nWARC-Type: response\r\nWARC-Target-URI: https://example.test/a\r\nContent-Length: ${Buffer.byteLength(PAYLOAD)}\r\n\r\n${PAYLOAD}`;

const inputFile = async (name: string, bytes: Uint8Array | string) => {
  const root = await createTestTempDirectory("rea-warc-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return path;
};

it("binds the published archive bytes to Evidence", async () => {
  const path = await inputFile("crawl.warc", RECORD);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectWarcArchiveEvidence({ path }, resources);
    if (!result.ok) throw new Error(`expected inspection: ${result.error}`);
    const value = warcArchiveSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(value.artifact).toEqual({
      path,
      bytes: Buffer.byteLength(RECORD),
      sha256: createHash("sha256").update(Buffer.from(RECORD)).digest("hex"),
    });
    expect(result.value.evidence.operation).toBe("inspect_warc_archive");
    expect(value.summary.responses).toBe(1);
    expect(value.records[0]?.http?.status_code).toBe(200);
    expect(value.source_coverage.payloads).toBe("header-block-only");
    expect(value.source_coverage.http_headers).toBe("decoded");
  } finally {
    await resources.close();
  }
});

it("decodes a gzip archive without contacting the target", async () => {
  const path = await inputFile("crawl.warc.gz", gzipSync(Buffer.from(RECORD)));
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectWarcArchiveEvidence({ path }, resources);
    if (!result.ok) throw new Error(`expected inspection: ${result.error}`);
    const value = warcArchiveSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(value.compression).toBe("gzip");
    expect(value.summary.records).toBe(1);
  } finally {
    await resources.close();
  }
});

it("does not retain transport credentials in Evidence", async () => {
  const payload =
    "HTTP/1.1 200 OK\r\nSet-Cookie: session=fixture-private\r\nX-Header: kept\r\n\r\n";
  const source = `WARC/1.1\r\nWARC-Type: response\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  const path = await inputFile("credentials.warc", source);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectWarcArchiveEvidence({ path }, resources);
    if (!result.ok) throw new Error(`expected inspection: ${result.error}`);
    const archive = warcArchiveSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(archive.records[0]?.http?.headers).toEqual([
      { name: "Set-Cookie", value: null },
      { name: "X-Header", value: "kept" },
    ]);
    expect(JSON.stringify(result.value.evidence)).not.toContain(
      "fixture-private",
    );
  } finally {
    await resources.close();
  }
});

it("keeps a malformed archive as diagnostics instead of failing the read", async () => {
  const path = await inputFile("crawl.warc", "not an archive at all");
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectWarcArchiveEvidence({ path }, resources);
    if (!result.ok) throw new Error(`expected inspection: ${result.error}`);
    const value = warcArchiveSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(value.records).toEqual([]);
    expect(value.diagnostics[0]?.code).toBe("not-a-warc-stream");
    expect(value.source_coverage.status).toBe("partial");
  } finally {
    await resources.close();
  }
});

it("rejects a relative path before reading anything", async () => {
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectWarcArchiveEvidence(
      { path: "crawl.warc" },
      resources,
    );
    expect(result.ok).toBe(false);
  } finally {
    await resources.close();
  }
});

it("reports the selected path and cause when the archive cannot be resolved", async () => {
  const root = await createTestTempDirectory("rea-warc-missing-");
  const blocker = join(root, "file");
  await writeFile(blocker, "x");
  const resources = new ArtifactResourceScope();
  try {
    for (const [path, code] of [
      [join(root, "missing.warc"), "ENOENT"],
      [join(blocker, "child.warc"), "ENOTDIR"],
    ] as const) {
      const result = await inspectWarcArchiveEvidence({ path }, resources);
      expect(result.ok).toBe(false);
      if (result.ok || !(result.error instanceof AnalysisInputError))
        throw new Error("Expected input refusal");
      const projected = projectAnalysisError(result.error);
      expect(projected.remediation.action).toContain("host running REA");
      expect(projected.recovery).toBeUndefined();
      expect(result.error.conformsToInputContract).toBe(true);
      expect(result.error.remediationAction).toContain("host running REA");
      expect(result.error.issues).toEqual([
        {
          path: ["path"],
          reason: "invalid_format",
          message: `Selected archive could not be read (${code}): ${path}`,
        },
      ]);
    }
  } finally {
    await resources.close();
  }
});
