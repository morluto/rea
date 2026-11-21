import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { RELEASE_EXPOSURE_TOOL_CONTRACTS } from "../../../src/contracts/releaseExposureToolContracts.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
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
  "reports exact CodeView path bytes with unknown encoding",
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
      const root = await createTestTempDirectory("rea-release-codeview-");
      const image = join(root, "app.exe");
      await writeFile(
        image,
        pe(0x8664, 64, 2, false, {
          pdbPath: Buffer.from("433a5ce92e706462", "hex"),
        }),
      );
      const response = await client.callTool(
        { name: "audit_release_exposure", arguments: { path: image } },
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
      expect(response.isError).not.toBe(true);
      const evidence = outputSchema.parse(response.structuredContent);
      const finding = evidence.normalized_result.checks.find(
        ({ id }) => id === "native.pdb_path",
      );
      expect(finding).toMatchObject({
        status: "exposed",
        locations: [{ kind: "artifact-path", path: image }],
        observation: {
          counts: { examined: 1, paths: 1, failed: 0 },
          samples: [],
          pdb_path_bytes: [
            {
              image_path: image,
              bytes_hex: "433a5ce92e706462",
              encoding: "unknown",
            },
          ],
        },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "keeps lossy text unknown while retaining a visible marker",
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
      for (const [source, status] of [
        [
          Buffer.concat([
            Buffer.from('const x = "'),
            Buffer.from([0xff]),
            Buffer.from('";'),
          ]),
          "unknown",
        ],
        [
          Buffer.concat([
            Buffer.from("-----BEGIN PRIVATE KEY-----\n"),
            Buffer.from([0xff]),
          ]),
          "exposed",
        ],
      ] as const) {
        const root = await createTestTempDirectory("rea-release-lossy-mcp-");
        await writeFile(join(root, "app.js"), source);
        const response = await client.callTool(
          { name: "audit_release_exposure", arguments: { path: root } },
          { toolDefinition: withCanonicalOutputSchema(definition) },
        );
        expect(response.isError).not.toBe(true);
        const evidence = outputSchema.parse(response.structuredContent);
        expect(
          evidence.normalized_result.checks.find(
            ({ id }) => id === "text.credential_markers",
          )?.status,
        ).toBe(status);
        expect(JSON.stringify(evidence)).not.toContain(
          "-----BEGIN PRIVATE KEY-----",
        );
      }
    } finally {
      await session.close();
    }
  },
);

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
        { toolDefinition: withCanonicalOutputSchema(definition) },
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
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
      expect(bad.isError).toBe(true);
    } finally {
      await session.close();
    }
  },
);
