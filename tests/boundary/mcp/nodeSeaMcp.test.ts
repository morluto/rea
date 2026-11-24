import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  nodeSeaPe,
  buildNodeSeaBlob,
} from "../../../src/artifacts/nodeSea/NodeSea.fixture.js";
import { peResourceFixture } from "../../../src/domain/pe/peResources.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  analysisViewResultSchema,
  artifactInventorySummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";

const expectOuterPeWithSeaLimitation = (
  reply: Parameters<typeof parseMcpToolError>[0],
  pattern: RegExp,
) => {
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const evidence = parseEvidence(reply.structuredContent);
  const summary = artifactInventorySummaryViewResultSchema.parse(
    evidence.normalized_result,
  );
  expect(summary.summary.manifest.root_format).toBe("pe");
  expect(evidence.limitations).toContainEqual(
    expect.stringMatching(/Node SEA recognition remains unknown/iu),
  );
  expect(evidence.limitations).toContainEqual(expect.stringMatching(pattern));
};

// The compiled stdio fixture checks advertised schemas against their dialect and
// validates actual tool responses, avoiding a second source server module graph.
it.each(["compact"] as const)(
  "exposes SEA facts and extraction through MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-sea-mcp-");
    const path = join(root, "application.exe");
    await writeFile(
      path,
      nodeSeaPe({
        codePath: "main.js",
        mainCodeFormat: 1,
        main: "export const marker = 1;",
        fuse: "set",
        assets: [
          { name: "data.txt", body: "data" },
          { name: "second.txt", body: "second" },
        ],
      }),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const lowerPolicy = { node_sea: { blob_bytes: 1 } };
      const limited = await call("inspect_artifact", {
        detail: "summary",
        artifact_limits: lowerPolicy,
      });
      expectOuterPeWithSeaLimitation(limited, /blob_bytes|1 bytes/iu);
      const assetRefusal = await call("inspect_artifact", {
        detail: "summary",
        artifact_limits: { node_sea: { asset_count: 1 } },
      });
      expect(parseMcpToolError(assetRefusal).error).toMatchObject({
        code: "partial",
        retryable: true,
        details: {
          operation: "inspect_artifact",
          reason: "limit",
          boundary: "capacity",
          truncated: true,
          reader_limit: {
            parameter: "artifact_limits.node_sea.asset_count",
            effective_value: 1,
            required_value: 2,
            unit: "count",
            can_increase: true,
          },
        },
      });
      const selectedPolicy = { node_sea: { blob_bytes: 4096, asset_count: 2 } };
      const reply = await call("inspect_artifact", {
        detail: "summary",
        artifact_limits: selectedPolicy,
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const summary = artifactInventorySummaryViewResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      expect(summary.summary.effective_limits?.node_sea).toMatchObject(
        selectedPolicy.node_sea,
      );
      expect(summary.summary.root_format_metadata).toMatchObject({
        kind: "node-sea",
        carrier: "pe",
        fuse_state: "set",
        code_path: "main.js",
        main_code_format: "module",
      });
      const bundleReply = await call("get_evidence_bundle", {
        detail: "complete",
      });
      expect(bundleReply.isError, JSON.stringify(bundleReply)).not.toBe(true);
      const bundle = toolContract("get_evidence_bundle").outputSchema.parse(
        bundleReply.structuredContent,
      ).result;
      if ("kind" in bundle)
        throw new Error("Expected complete retained Evidence");
      const parent = parseEvidence(
        bundle.records.find(
          (record) => record.evidence_id === summary.parent_evidence_id,
        ),
      );
      expect(parent.parameters.artifact_limits).toEqual(selectedPolicy);
      const retained = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: summary.parent_evidence_id,
        },
        view: {
          kind: "inventory",
          collection: "occurrences",
          logical_paths: ["main.js"],
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
            logical_path: "main.js",
            format_metadata: { kind: "node-sea-entry", role: "main-script" },
          },
        ],
      });
      const loweredAfterRetention = await call("inspect_artifact", {
        detail: "summary",
        artifact_limits: lowerPolicy,
      });
      expectOuterPeWithSeaLimitation(
        loweredAfterRetention,
        /blob_bytes|1 bytes/iu,
      );
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(await readFile(join(result.output_root, "data.txt"), "utf8")).toBe(
        "data",
      );
      expect((await call("close_binary", {})).isError).not.toBe(true);
      await writeFile(path, nodeSeaPe({ blob: Buffer.alloc(16) }));
      expect((await call("open_binary", { path })).isError).not.toBe(true);
      const invalid = await call("inspect_artifact", { detail: "summary" });
      expectOuterPeWithSeaLimitation(invalid, /magic/iu);
      expect((await call("close_binary", {})).isError).not.toBe(true);
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

it("reports the PE parser budget when Node SEA inventory exhausts it", async () => {
  const root = await createTestTempDirectory("rea-sea-pe-budget-");
  const path = join(root, "application.exe");
  // Long sibling resource names expand into both source text and hex metadata.
  const longName = "a".repeat(16 * 1024);
  const { bytes } = peResourceFixture(
    true,
    [
      {
        type: 10,
        name: "NODE_SEA_BLOB",
        language: 1033,
        payload: buildNodeSeaBlob(),
      },
      ...Array.from({ length: 96 }, (_, index) => ({
        type: 11,
        name: longName + String(index),
        language: 1033,
        payload: Buffer.from("inert"),
      })),
    ],
    4 * 1024 * 1024,
  );
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const reply = await call("inspect_artifact", {});
  expect(parseMcpToolError(reply).error).toMatchObject({
    code: "partial",
    retryable: false,
    details: {
      operation: "inspect_artifact",
      reason: "limit",
      boundary: "memory",
      truncated: true,
      reported_limits: {
        boundary: "pe_resource_metadata_bytes",
        maximum: 8 * 1024 * 1024,
      },
    },
  });
});
