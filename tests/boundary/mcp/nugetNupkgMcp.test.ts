import { nugetNupkgSchema } from "../../../src/domain/nuget/nupkg.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipReader } from "@zip.js/zip.js";
import { expect, vi } from "vitest";
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

mcpTest(
  "advises a fixed allowance, not more memory, for a Zstandard window refusal",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const refusal = Object.assign(new Error("Frame requires too much memory"), {
      code: "ZSTD_error_frameParameter_windowTooLarge",
    });
    const original = ZipReader.prototype.getEntriesGenerator;
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* (this: ZipReader<unknown>, options) {
        for await (const entry of original.call(this, options)) {
          if (entry.filename === "Demo.Package.nuspec" && !entry.directory) {
            entry.compressionMethod = 93;
            entry.getData = () => Promise.reject(refusal);
          }
          yield entry;
        }
        return true;
      });
    try {
      const root = await createTestTempDirectory("rea-nupkg-mcp-");
      const path = join(root, "Demo.Package.nupkg");
      await writeFile(path, await nugetNupkgFixture());
      const response = await client.callTool({
        name: "inspect_nuget_nupkg",
        arguments: { path },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        remediation: {
          action: expect.stringContaining("ZIP Zstandard decoder window"),
        },
      });
      expect(error.remediation.action).toMatch(/host memory do not raise/iu);
    } finally {
      enumeration.mockRestore();
      await session.close();
    }
  },
);
