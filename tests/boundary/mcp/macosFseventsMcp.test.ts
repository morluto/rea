import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { expect, it } from "vitest";

import { FSEVENTS_MAX_INLINE_PATH_BYTES } from "../../../src/domain/apple/macosFseventsFlags.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const buildStoreFixture = (pathBytes: Buffer): Buffer => {
  const rec = Buffer.alloc(pathBytes.length + 1 + 20);
  pathBytes.copy(rec, 0);
  rec[pathBytes.length] = 0;
  rec.writeBigUInt64LE(42n, pathBytes.length + 1);
  rec.writeUInt32LE(0x0080_0001, pathBytes.length + 9);
  rec.writeBigUInt64LE(99n, pathBytes.length + 13);
  const header = Buffer.alloc(12);
  header.write("2SLD", 0, "latin1");
  header.writeUInt32LE(12 + rec.length, 8);
  return gzipSync(Buffer.concat([header, rec]));
};

it("inspects valid macOS FSEvents stores and surfaces fixed-ceiling limits through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-fsevents-mcp-");
  const validPath = join(root, "0000000000000100");
  await writeFile(
    validPath,
    buildStoreFixture(Buffer.from("/Users/alice/a.txt")),
  );

  const oversizedPath = join(root, "0000000000000101");
  await writeFile(
    oversizedPath,
    buildStoreFixture(Buffer.alloc(FSEVENTS_MAX_INLINE_PATH_BYTES + 1, 0x78)),
  );

  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  try {
    expect((await call("open_binary", { path: validPath })).isError).not.toBe(
      true,
    );
    const inspected = await call("inspect_artifact", {});
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.occurrences[0]).toMatchObject({
      artifact_kind: "resource",
      artifact_format: "macos-fsevents",
      format_metadata: {
        kind: "macos-fsevents",
        record_count: 1,
        records: [
          { event_id: "42", path: "/Users/alice/a.txt", node_id: "99" },
        ],
      },
    });
    expect((await call("close_binary", {})).isError).not.toBe(true);

    expect(
      (await call("open_binary", { path: oversizedPath })).isError,
    ).not.toBe(true);
    const { error } = parseMcpToolError(await call("inspect_artifact", {}));
    expect(error).toMatchObject({
      code: "partial",
      category: "partial",
      retryable: false,
      remediation: {
        action: expect.stringContaining("no runtime override"),
      },
      details: {
        operation: "inspect_artifact",
        reason: "limit",
        truncated: true,
        boundary: "capacity",
        refusal: {
          kind: "fixed_ceiling",
          operation: "inspect_artifact",
          allowance_kind: "parser",
          limit: FSEVENTS_MAX_INLINE_PATH_BYTES,
          unit: "bytes",
        },
      },
    });
  } finally {
    await call("close_binary", {});
  }
});
