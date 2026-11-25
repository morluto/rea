import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { inventoryEvidence } from "../../fixtures/artifactComparisonMcp.js";
import { nestedAsarHeader } from "../../fixtures/asarHeader.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { openArtifactTarget } from "../../support/mcp/artifactSession.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "reports expanded ASAR admission failure and inspects a valid replacement target",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-asar-listing-mcp-");
    const path = join(root, "app.asar");
    const bytes = nestedAsarHeader(64, "d".repeat(256), 4000);
    await writeFile(path, bytes);
    const client = await openArtifactTarget(mcp, onTestFinished, path);
    const inspect = () =>
      client.callTool({ name: "inspect_artifact", arguments: {} });
    const refused = await inspect();
    expect(parseMcpToolError(refused).error).toMatchObject({
      code: "partial",
      category: "partial",
      details: {
        admission: "asar-listing",
        limit: { setting: "asar.max_listing_bytes", unit: "bytes" },
      },
    });
    expect(refused.structuredContent).toBeUndefined();
    expect((await readFile(path)).equals(bytes)).toBe(true);

    const valid = join(root, "valid.asar");
    await writeFile(valid, nestedAsarHeader(1, "lib", 1));
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: valid },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const accepted = await inspect();
    expect(accepted.isError, JSON.stringify(accepted.content)).not.toBe(true);
    const evidence = inventoryEvidence(accepted.structuredContent);
    expect(evidence.subject?.local_path).toBe(valid);
    const inventory = artifactInventoryResultSchema.parse(
      evidence.normalized_result,
    );
    expect(
      inventory.occurrences.map(({ logical_path }) => logical_path),
    ).toEqual([".", "lib", "lib/f0"]);
  },
);
