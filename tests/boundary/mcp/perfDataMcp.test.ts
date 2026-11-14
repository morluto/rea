import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { perfDataSchema } from "../../../src/domain/perfData/perfData.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { buildPerfRecording, perfEntry } from "../../fixtures/perfData.js";

it.each(["full", "compact"] as const)(
  "imports a perf recording through compiled MCP (%s)",
  async (profile) => {
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
    const root = await createTestTempDirectory("rea-perf-mcp-");
    const path = join(root, "perf.data");
    await writeFile(path, bytes);
    const harness = await createApplicationMcpHarness({
      serverOptions: {
        environment: {
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    });
    try {
      const listed = await harness.client.listTools();
      const tool = listed.tools.find(
        (entry) => entry.name === "inspect_perf_data",
      );
      if (tool === undefined) throw new Error("perf tool missing");
      expect(tool.outputSchema).toBeDefined();

      const reply = await harness.client.callTool({
        name: "inspect_perf_data",
        arguments: { path, max_events: 10 },
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const inventory = perfDataSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      expect(inventory.artifact).toMatchObject({ path, bytes: bytes.length });
      expect(inventory.file_header.byte_order).toBe("little-endian");
      expect(inventory.events.map((event) => event.config)).toEqual([0, 3]);
      expect(inventory.events.map((event) => event.sample_freq)).toEqual([
        false,
        true,
      ]);
      expect(inventory.summary).toMatchObject({ events: 2, identifiers: 2 });
      expect(inventory.diagnostics).toEqual([]);
      await harness.client.ping();
    } finally {
      await harness.close();
    }
  },
);

it("reports a non-perf file as partial inventory rather than a transport error", async () => {
  const root = await createTestTempDirectory("rea-perf-mcp-");
  const path = join(root, "notes.bin");
  await writeFile(path, Buffer.from("definitely not perf"));
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  try {
    const reply = await harness.client.callTool({
      name: "inspect_perf_data",
      arguments: { path },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const inventory = perfDataSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    expect(inventory.events).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      expect.objectContaining({ code: "not-a-perf-data-file" }),
    ]);
    expect(inventory.source_coverage.status).toBe("partial");
  } finally {
    await harness.close();
  }
});
