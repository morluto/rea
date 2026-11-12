import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { RELEASE_EXPOSURE_TOOL_CONTRACTS } from "../../../src/contracts/releaseExposureToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const PLANTED_SOURCE = "release-exposure-planted-secret-7c2e9a";
const releaseExposureContract = RELEASE_EXPOSURE_TOOL_CONTRACTS.find(
  (contract) => contract.name === "audit_release_exposure",
);
if (releaseExposureContract === undefined)
  throw new Error("Missing release exposure contract");
const outputSchema = releaseExposureContract.outputSchema;

mcpTest(
  "advertises and reads release exposure without changing the artifact",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "audit_release_exposure",
      );
      if (definition === undefined)
        throw new Error("Missing advertised contract");
      expect(definition.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-release-exposure-mcp-");
      await writeFile(
        join(root, "app.js.map"),
        JSON.stringify({
          version: 3,
          file: "app.js",
          sources: ["app.js"],
          names: [],
          mappings: "",
          sourcesContent: [PLANTED_SOURCE],
        }),
      );
      const response = await client.callTool(
        { name: "audit_release_exposure", arguments: { path: root } },
        { toolDefinition: definition },
      );
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = outputSchema.parse(response.structuredContent);
      expect(
        evidence.normalized_result.checks.find(
          (check) => check.id === "javascript.source_map_sources",
        )?.status,
      ).toBe("exposed");
      expect(JSON.stringify(evidence)).not.toContain(PLANTED_SOURCE);
      const bad = await client.callTool(
        {
          name: "audit_release_exposure",
          arguments: { path: "relative-dir" },
        },
        { toolDefinition: definition },
      );
      expect(bad.isError).toBe(true);
    } finally {
      await session.close();
    }
  },
  60_000,
);
