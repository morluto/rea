import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  machoArm64FatInitializers,
  machoArm64Initializers,
  elf64PieInitializers,
} from "../../../src/native/initializers/NativeInitializers.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../../fixtures/universalMacho.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Initializer listing must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

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
      expect(missing.isError).toBe(true);
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
  "reads the arm64 or arm64e slice that the architecture names",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      // The x86_64, arm64 and arm64e layout of stock tools such as /usr/bin/file.
      const thin = machoArm64Initializers();
      const universal = universalMacho([
        { bytes: thin, cpuType: CPU_X86_64, cpuSubtype: 3 },
        { bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0 },
        { bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0x80000002 },
      ]);
      const root = await createTestTempDirectory("rea-native-init-arm64e-mcp-");
      const path = join(root, "universal");
      await writeFile(path, universal.bytes);
      const read = async (architecture: string) => {
        const response = await client.callTool({
          name: "inspect_native_initializers",
          arguments: { path, architecture },
        });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(
          true,
        );
        return toolContract("inspect_native_initializers").outputSchema.parse(
          response.structuredContent,
        ).normalized_result;
      };
      const arm64 = await read("arm64");
      expect(arm64).toMatchObject({
        format: "mach-o",
        slice: {
          file_offset: universal.slices[1]?.offset,
          cpu_subtype: 0,
          architecture: "arm64",
        },
      });
      expect(arm64.entries.length).toBeGreaterThan(0);
      // The arm64e slice is not read, and the result names the value that reads it.
      expect(arm64.limitations).toContain(
        `Only the selected arm64 slice (arm64 (subtype 0x0) at file offset ${String(universal.slices[1]?.offset)}) was read; this universal Mach-O also holds arm64 (subtype 0x80000002) at file offset ${String(universal.slices[2]?.offset)} (architecture arm64e selects it).`,
      );
      expect(await read("arm64e")).toMatchObject({
        slice: {
          file_offset: universal.slices[2]?.offset,
          cpu_subtype: 0x80000002,
        },
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
