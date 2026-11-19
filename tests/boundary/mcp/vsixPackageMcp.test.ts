import { vsixPackageSchema } from "../../../src/domain/vsix/vsixPackage.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipReader } from "@zip.js/zip.js";
import { expect, vi } from "vitest";
import { VSIX_PACKAGE_TOOL_CONTRACTS } from "../../../src/contracts/vsix/vsixPackageToolContracts.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { vsixPackageFixture } from "../../../src/vsix/VsixPackage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const vsixContract = contractNamed(
  VSIX_PACKAGE_TOOL_CONTRACTS,
  "inspect_vsix_package",
);
const completeVsixEvidenceSchema = vsixContract.outputSchema.safeExtend({
  normalized_result: vsixPackageSchema,
});

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("VS Code vsix inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_vsix_package and reads package identity",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_vsix_package",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeVsixEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.vsix_identity?.id).toBe("demo.hello");
      expect(evidence.normalized_result.vsix_identity?.version).toBe("1.2.3");
      expect(evidence.normalized_result.package_identity?.name).toBe("hello");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_vsix_package",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path: "pkg.vsix" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_vsix_package" },
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
          if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
            entry.compressionMethod = 93;
            entry.getData = () => Promise.reject(refusal);
          }
          yield entry;
        }
        return true;
      });
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
        arguments: { path },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
      });
      expect(error.remediation.action).toContain(
        "Recompress the member with a window of at most 128 MiB",
      );
      expect(error.details?.refusal).toMatchObject({
        kind: "fixed_ceiling",
        limit: 128 * 1024 * 1024,
        unit: "bytes",
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
          if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
            entry.compressionMethod = 93;
            entry.getData = () => Promise.reject(refusal);
          }
          yield entry;
        }
        return true;
      });
    try {
      const root = await createTestTempDirectory("rea-vsix-mcp-");
      const path = join(root, "demo.hello.vsix");
      await writeFile(path, await vsixPackageFixture());
      const response = await client.callTool({
        name: "inspect_vsix_package",
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
