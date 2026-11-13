import { nugetNupkgSchema } from "../../../src/domain/nuget/nupkg.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { nugetNupkgFixture } from "../../../src/nuget/NugetNupkg.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const completeNupkgEvidenceSchema = toolContract(
  "inspect_nuget_nupkg",
).outputSchema.safeExtend({ normalized_result: nugetNupkgSchema });

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("NuGet inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_nuget_nupkg and reads package identity",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_nuget_nupkg",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-nupkg-mcp-");
      const path = join(root, "Demo.Package.nupkg");
      await writeFile(path, await nugetNupkgFixture());
      const response = await client.callTool({
        name: "inspect_nuget_nupkg",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeNupkgEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.identity?.id).toBe("Demo.Package");
      expect(evidence.normalized_result.identity?.version).toBe("1.2.3");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_nuget_nupkg",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_nuget_nupkg",
        arguments: { path: "pkg.nupkg" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_nuget_nupkg" },
      });
    } finally {
      await session.close();
    }
  },
);
