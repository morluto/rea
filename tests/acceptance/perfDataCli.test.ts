import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { perfDataSchema } from "../../src/domain/perfData/perfData.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { buildPerfRecording, perfEntry } from "../fixtures/perfData.js";
import { cliTest } from "../support/cli/cliFixture.js";

const completePerfEvidenceSchema = toolContract(
  "inspect_perf_data",
).outputSchema.safeExtend({ normalized_result: perfDataSchema });

cliTest(
  "reports perf recording header and attributes through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-perf-cli-");
    const path = join(root, "perf.data");
    const bytes = buildPerfRecording({
      entries: [
        perfEntry({ type: 0, config: 0, samplePeriod: 1000, ids: [7] }),
        perfEntry({
          type: 1,
          config: 3,
          samplePeriod: 4000,
          freq: true,
          ids: [8],
        }),
      ],
    });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-perf-data", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePerfEvidenceSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, format: "file" },
    });
    expect(evidence.normalized_result).toMatchObject({
      format: "perf-data",
      file_header: {
        byte_order: "little-endian",
        attribute_bytes: 144,
        feature_bitmap: "present",
      },
      events: [
        { ordinal: 0, type: 0, config: 0, sample_period: 1000, ids: [7] },
        { ordinal: 1, type: 1, config: 3, sample_period: 4000, ids: [8] },
      ],
      summary: { events: 2, identifiers: 2, identifiers_present: true },
      diagnostics: [],
    });
  },
);

cliTest(
  "reports a non-perf file as partial inventory rather than failing the command",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-perf-cli-");
    const path = join(root, "notes.bin");
    await writeFile(path, Buffer.from("not a recording"));
    const result = await cli.run({
      arguments: ["inspect-perf-data", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePerfEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      events: [],
      diagnostics: [{ code: "not-a-perf-data-file" }],
      source_coverage: { status: "partial" },
    });
  },
);
