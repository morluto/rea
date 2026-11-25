import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  inspectInventorySummary,
  inspectRetainedOccurrences,
} from "../../fixtures/artifactInventoryMcp.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  gzipTarFixture,
  RELEASE_TAR_MEMBERS,
} from "../../../src/artifacts/tar/tar.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";

it("exposes gzip tar facts, paged members and extraction through MCP", async () => {
  const root = await createTestTempDirectory("rea-tar-mcp-");
  const path = join(root, "package.unitypackage");
  await writeFile(path, gzipTarFixture(RELEASE_TAR_MEMBERS));
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const summary = await inspectInventorySummary(call);
    expect(summary.summary.root_format_metadata).toMatchObject({
      kind: "tar",
      compression: "gzip",
      member_count: 4,
    });
    const view = await inspectRetainedOccurrences(
      call,
      summary.parent_evidence_id,
      {
        logical_paths: ["app/run.x86_64"],
        fields: ["logical_path", "executable", "format_metadata"],
      },
    );
    expect(view).toMatchObject({
      kind: "inventory",
      items: [
        expect.objectContaining({
          logical_path: "app/run.x86_64",
          executable: true,
          format_metadata: expect.objectContaining({
            kind: "tar-entry",
            mode: 0o755,
          }),
        }),
      ],
    });
    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(
      await readFile(join(result.output_root, "app/data.pck"), "utf8"),
    ).toBe("GDPC-not-really");
    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});
