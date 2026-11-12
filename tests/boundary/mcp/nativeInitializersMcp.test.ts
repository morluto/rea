import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  machoArm64FatInitializers,
  elf64PieInitializers,
  elf64AliasedInitializers,
  elfUnmappedInitializerTargets,
} from "../../../src/native/initializers/NativeInitializers.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Initializer listing must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "resolves two independently relocated ELF aliases through MCP",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-native-init-alias-mcp-");
      const path = join(root, "program");
      const bytes = elf64AliasedInitializers();
      bytes.writeBigUInt64LE(0x1200n, 0x4b0);
      await writeFile(path, bytes);
      const response = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const report = toolContract(
        "inspect_native_initializers",
      ).outputSchema.parse(response.structuredContent).normalized_result;
      expect(report.status).toBe("parsed");
      expect(
        report.entries
          .filter((entry) =>
            ["preinit_array", "init_array"].includes(entry.kind),
          )
          .map((entry) => [entry.slot_va, entry.value_va, entry.resolution]),
      ).toEqual([
        ["0x200", "0x100", "relative_addend"],
        ["0x1200", "0x110", "relative_addend"],
      ]);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "advertises inspect_native_initializers and pages ELF initializers",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_native_initializers",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-native-init-mcp-");
      const path = join(root, "program");
      await writeFile(path, elf64PieInitializers());
      const response = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path, offset: 2, limit: 3 },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_native_initializers",
      ).outputSchema.parse(response.structuredContent);
      expect(evidence.normalized_result.coverage).toMatchObject({
        status: "complete",
        total_entries: 7,
        returned_entries: 3,
        offset: 2,
      });
      expect(
        evidence.normalized_result.entries.map((entry) => entry.resolution),
      ).toEqual(["relative_addend", "relative_addend", "unresolved_import"]);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an architecture for a universal Mach-O and reads the selected slice",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-native-init-fat-mcp-");
      const path = join(root, "universal");
      await writeFile(path, machoArm64FatInitializers());
      const missing = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path },
      });
      expect(parseMcpToolError(missing).error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_native_initializers",
          issues: [
            {
              path: ["architecture"],
              reason: "invalid_value",
              message: expect.stringMatching(
                /arm64 \(subtype 0x0\).*select one architecture/u,
              ),
            },
          ],
        },
      });
      const selected = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path, architecture: "arm64" },
      });
      expect(selected.isError, JSON.stringify(selected.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_native_initializers",
      ).outputSchema.parse(selected.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        format: "mach-o",
        slice: { file_offset: 0x1000, architecture: "arm64" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_native_initializers",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path: "program" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_native_initializers" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "retains unmapped ELF values without fabricating target file locations",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory(
        "rea-native-init-unmapped-mcp-",
      );
      const path = join(root, "program");
      await writeFile(path, elfUnmappedInitializerTargets());
      const response = await client.callTool({
        name: "inspect_native_initializers",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_native_initializers",
      ).outputSchema.parse(response.structuredContent);
      expect(
        evidence.normalized_result.entries.map((entry) => [
          entry.value_va,
          entry.value_file_offset,
        ]),
      ).toEqual([
        ["0x0", null],
        ["0x10", null],
        ["0x401000", 0x100],
      ]);
      expect(evidence.normalized_result.coverage).toMatchObject({
        examined_entries: 3,
        total_entries: 3,
      });
    } finally {
      await session.close();
    }
  },
);
