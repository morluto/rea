import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { elfDependencyFixture } from "../../../src/native/elf/ElfDependencies.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("ELF dependency inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_elf_dependencies and reads a 32-bit big-endian image",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_elf_dependencies",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-elf-dependencies-mcp-");
      const path = join(root, "program");
      await writeFile(path, elfDependencyFixture({ bits: 32, little: false }));
      const response = await client.callTool({
        name: "inspect_elf_dependencies",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_elf_dependencies",
      ).outputSchema.parse(response.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        format: "elf32",
        byte_order: "big",
        machine: 8,
        dynamic: { runpath: { tokens: ["$ORIGIN"] } },
      });
      expect(
        (evidence.normalized_result as { needed: { name: string | null }[] })
          .needed[0]?.name,
      ).toBe("libstdc++.so.6");
      expect(evidence.subject?.architecture).toBe("mips");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_elf_dependencies",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_elf_dependencies",
        arguments: { path: "program" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_elf_dependencies" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a stripped image from program headers without a disassembler session",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory(
        "rea-elf-dependencies-stripped-mcp-",
      );
      const path = join(root, "program");
      await writeFile(path, elfDependencyFixture({ stripped: true }));
      const response = await client.callTool({
        name: "inspect_elf_dependencies",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_elf_dependencies",
      ).outputSchema.parse(response.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        coverage: { status: "complete" },
        needed: [
          { name: "libstdc++.so.6" },
          { name: "libm.so.6" },
          { name: "libc.so.6" },
        ],
      });
    } finally {
      await session.close();
    }
  },
);
