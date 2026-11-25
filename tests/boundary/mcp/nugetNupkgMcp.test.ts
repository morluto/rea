import { nugetNupkgSchema } from "../../../src/domain/nuget/nupkg.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipReader } from "@zip.js/zip.js";
import { expect, vi } from "vitest";
import { NUGET_NUPKG_TOOL_CONTRACTS } from "../../../src/contracts/nuget/nupkgToolContracts.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { nugetNupkgFixture } from "../../../src/nuget/NugetNupkg.fixture.js";
import { ZIP_ZSTANDARD_WINDOW_CEILING } from "../../../src/resources/ZipArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const nupkgContract = contractNamed(
  NUGET_NUPKG_TOOL_CONTRACTS,
  "inspect_nuget_nupkg",
);
const completeNupkgEvidenceSchema = nupkgContract.outputSchema.safeExtend({
  normalized_result: nugetNupkgSchema,
});

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
        details: {
          refusal: {
            kind: "fixed_ceiling",
            limit: ZIP_ZSTANDARD_WINDOW_CEILING.limit,
            unit: ZIP_ZSTANDARD_WINDOW_CEILING.unit,
            narrowing: ZIP_ZSTANDARD_WINDOW_CEILING.narrowing,
          },
        },
      });
    } finally {
      enumeration.mockRestore();
      await session.close();
    }
  },
);

mcpTest(
  "reports a Zstandard dictionary member as an unsupported target, not a malformed package",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    const refusal = Object.assign(new Error("Dictionary mismatch"), {
      code: "ZSTD_error_dictionary_wrong",
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
      expect(error.code).toBe("unsupported_target");
      expect(error.message).toMatch(/Zstandard dictionary/u);
    } finally {
      enumeration.mockRestore();
      await session.close();
    }
  },
);
