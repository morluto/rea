import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { evtxArchiveSchema } from "../../src/domain/evtxArchive/evtxArchive.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "publishes a EVTX summary while retaining partial source coverage and full parent Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evtx-summary-");
    const bytes = Buffer.alloc(128 + 65_536);
    bytes.write("ElfFile\0", 0, "latin1");
    bytes.writeUInt16LE(1, 0x24);
    bytes.writeUInt16LE(3, 0x26);
    bytes.writeUInt16LE(128, 0x28);
    bytes.writeUInt16LE(1, 0x2a);
    const chunk = bytes.subarray(128);
    chunk.write("ElfChnk\0", 0, "latin1");
    chunk.writeBigUInt64LE(1n, 0x18);
    chunk.writeUInt32LE(536, 0x2c);
    chunk.writeUInt32LE(560, 0x30);
    for (const [index, offset] of [512, 536].entries()) {
      chunk.writeUInt32LE(0x2a2a, offset);
      chunk.writeUInt32LE(24, offset + 4);
      chunk.writeBigUInt64LE(BigInt(index + 1), offset + 8);
    }
    const path = join(root, "input.evtx");
    const output = join(root, "evidence.json");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-evtx-archive",
        "./input.evtx",
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
      (record) => record.operation === "inspect_evtx_archive",
    );
    expect(parent).toBeDefined();
    if (parent === undefined)
      throw new Error("Missing complete parent Evidence");
    const report = evtxArchiveSchema.parse(parent.normalized_result);
    expect(parent.caller_input_path).toBe("./input.evtx");
    expect(report.events).toHaveLength(1);
    expect(report.source_coverage.status).toBe("partial");
    expect(summary).toMatchObject({
      kind: "summary",
      parent_evidence_id: parent.evidence_id,
      parent_digest: parent.evidence_id.slice(3),
      parent_operation: "inspect_evtx_archive",
      summary: {
        artifact: report.artifact,
        summary: report.summary,
        source_coverage: report.source_coverage,
      },
    });
    expect(summary.kind).toBe("summary");
    if (summary.kind === "summary")
      expect(summary.summary).not.toHaveProperty("events");
  },
);
