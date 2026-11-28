import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { perfDataSchema } from "../../src/domain/perfData/perfData.js";
import { PERF_DATA_TOOL_CONTRACTS } from "../../src/contracts/perfDataToolContracts.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { buildPerfRecording, perfEntry } from "../fixtures/perfData.js";
import { cliTest } from "../support/cli/cliFixture.js";

const completePerfEvidenceSchema = contractNamed(
  PERF_DATA_TOOL_CONTRACTS,
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
      subject: { identity: { kind: "file" }, local_path: path },
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
    const bounded = await cli.run({
      arguments: [
        "inspect-perf-data",
        path,
        "--max-identifiers",
        "1",
        "--json",
      ],
    });
    expect(bounded.exitCode, bounded.stderr).toBe(0);
    const limited = completePerfEvidenceSchema.parse(bounded.json);
    expect(limited.parameters).toMatchObject({ max_identifiers: 1 });
    expect(limited.normalized_result).toMatchObject({
      summary: { identifiers: 1, identifiers_present: false },
      diagnostics: [
        {
          code: "identifier-inventory-truncated",
          limit: { parameter: "max_identifiers", effective_value: 1 },
        },
      ],
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
