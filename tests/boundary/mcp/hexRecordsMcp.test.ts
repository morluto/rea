import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { SREC_S37 } from "../../../src/domain/firmware/hexRecords.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

// The compiled stdio fixture checks advertised schemas against their dialect and
// validates actual tool responses, avoiding a second source server module graph.
it.each(["full", "compact"] as const)(
  "preserves S28 high address bytes through MCP inventory and extraction (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-s28-mcp-");
    const path = join(root, "firmware.s28");
    const bytes = Buffer.from("S208FEDCBADEADBEEF2B\nS804FEDCBA67\n");
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const inspected = await call("inspect_artifact", { detail: "summary" });
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const summary = z
        .object({
          summary: z.object({ root_format_metadata: z.unknown() }),
        })
        .parse(parseEvidence(inspected.structuredContent).normalized_result);
      expect(summary.summary.root_format_metadata).toMatchObject({
        kind: "hex-records",
        encoding: "srec",
        variant: "S28",
        lowest_address: 0xfe_dcba,
        highest_address: 0xfe_dcbd,
        start_address: 0xfe_dcba,
        start_address_record: "S8",
      });
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(result.containment_verified).toBe(true);
      expect(
        (await readFile(join(outputRoot, "0x00fedcba-0x00fedcbd.bin"))).equals(
          Buffer.from("deadbeef", "hex"),
        ),
      ).toBe(true);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

it.each(["full", "compact"] as const)(
  "exposes S-record facts and region extraction through MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-hex-mcp-");
    const path = join(root, "firmware.s37");
    await writeFile(path, SREC_S37);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const reply = await call("inspect_artifact", { detail: "summary" });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const summary = z
        .object({
          parent_evidence_id: z.string(),
          summary: z.object({ root_format_metadata: z.unknown() }),
        })
        .parse(parseEvidence(reply.structuredContent).normalized_result);
      expect(summary.summary.root_format_metadata).toMatchObject({
        kind: "hex-records",
        encoding: "srec",
        variant: "S37",
        start_address: 0x0800_0101,
        start_address_record: "S7",
      });
      const retained = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: summary.parent_evidence_id,
        },
        view: {
          kind: "inventory",
          collection: "occurrences",
          logical_paths: ["0x08000000-0x08000003.bin"],
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
            logical_path: "0x08000000-0x08000003.bin",
            format_metadata: { kind: "hex-record-region" },
          },
        ],
      });
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(
        Buffer.compare(
          await readFile(join(result.output_root, "0x08000000-0x08000003.bin")),
          Buffer.from("deadbeef", "hex"),
        ),
      ).toBe(0);
      await call("close_binary", {});
      await writeFile(path, SREC_S37.replace("S70508000101F0", "S4030000FC"));
      await call("open_binary", { path });
      const invalid = await call("inspect_artifact", {});
      expect(JSON.stringify(parseMcpToolError(invalid))).toContain(
        "S-record is malformed: line 2: reserved record type S4",
      );
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);
