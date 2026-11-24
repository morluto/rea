import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";

it("retains and extracts a high-address S28 region and projects a reserved-record error through MCP", async () => {
  const root = await createTestTempDirectory("rea-s28-mcp-");
  const path = join(root, "firmware.s28");
  const bytes = Buffer.from("S208FEDCBADEADBEEF2B\nS804FEDCBA67\n");
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp({});
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await call("inspect_artifact", { detail: "summary" });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const { parent_evidence_id, summary } = z
    .object({
      parent_evidence_id: z.string(),
      summary: z.object({ root_format_metadata: z.unknown() }),
    })
    .parse(parseEvidence(inspected.structuredContent).normalized_result);
  expect(summary.root_format_metadata).toMatchObject({
    kind: "hex-records",
    encoding: "srec",
    variant: "S28",
    lowest_address: 0xfe_dcba,
    highest_address: 0xfe_dcbd,
    start_address: 0xfe_dcba,
    start_address_record: "S8",
  });
  const region = "0x00fedcba-0x00fedcbd.bin";
  const extracted = await call("extract_artifact", {});
  expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
  const result = artifactExtractionResultSchema.parse(
    parseEvidence(extracted.structuredContent).normalized_result,
  );
  try {
    expect(result.containment_verified).toBe(true);
    expect(
      (await readFile(join(result.output_root, region))).equals(
        Buffer.from("deadbeef", "hex"),
      ),
    ).toBe(true);
    expect((await readFile(path)).equals(bytes)).toBe(true);
    await unlink(path);

    const retained = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: parent_evidence_id },
      view: {
        kind: "inventory",
        collection: "occurrences",
        logical_paths: [region],
        fields: ["logical_path", "format_metadata"],
      },
    });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const view = analysisViewResultSchema.parse(
      parseEvidence(retained.structuredContent).normalized_result,
    );
    expect(view).toMatchObject({
      kind: "inventory",
      items: [
        {
          logical_path: region,
          format_metadata: {
            kind: "hex-record-region",
            start_address: 0xfe_dcba,
            end_address: 0xfe_dcbd,
            length: 4,
          },
        },
      ],
    });

    const invalidPath = join(root, "reserved.srec");
    await writeFile(invalidPath, "S208FEDCBADEADBEEF2B\nS4030000FC\n");
    const invalidTarget = await call("open_binary", { path: invalidPath });
    expect(invalidTarget.isError, JSON.stringify(invalidTarget)).not.toBe(true);
    const invalid = parseMcpToolError(await call("inspect_artifact", {}));
    expect(invalid.error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_artifact",
        reason: "malformed",
        failure_kind: "malformed",
      },
    });
    expect(JSON.stringify(invalid)).toContain(
      "line 2: reserved record type S4",
    );
  } finally {
    await rm(result.output_root, { recursive: true, force: true });
  }
});
