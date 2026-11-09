import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { warcArchiveSchema } from "../../src/domain/warcArchive/warcArchive.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "publishes a WARC summary while retaining partial source coverage and full parent Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-warc-summary-");
    const bytes = Buffer.from(
      "WARC/1.1\r\nWARC-Type: resource\r\nContent-Length: 0\r\n\r\n".repeat(2),
    );
    const path = join(root, "input.warc");
    const output = join(root, "evidence.json");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-warc-archive",
        "./input.warc",
        "--maxRecords",
        "1",
        "--detail",
        "summary",
        "--evidence_output",
        output,
        "--json",
      ],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const summaryEvidence = parseEvidence(
      (result.json as { summary: unknown }).summary,
    );
    const summary = analysisViewResultSchema.parse(
      summaryEvidence.normalized_result,
    );
    const saved = await readEvidenceBundle(output);
    if (!saved.ok) throw saved.error;
    const parent = saved.value.records.find(
      (record) => record.operation === "inspect_warc_archive",
    );
    expect(parent).toBeDefined();
    if (parent === undefined)
      throw new Error("Missing complete parent Evidence");
    const report = warcArchiveSchema.parse(parent.normalized_result);
    expect(parent.caller_input_path).toBe("./input.warc");
    expect(report.records).toHaveLength(1);
    expect(report.source_coverage.status).toBe("partial");
    expect(summary).toMatchObject({
      kind: "summary",
      parent_evidence_id: parent.evidence_id,
      parent_digest: parent.evidence_id.slice(3),
      parent_operation: "inspect_warc_archive",
      summary: {
        artifact: report.artifact,
        summary: report.summary,
        source_coverage: report.source_coverage,
      },
    });
    expect(summary.kind).toBe("summary");
    if (summary.kind === "summary")
      expect(summary.summary).not.toHaveProperty("records");
  },
);
