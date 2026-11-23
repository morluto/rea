import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  UNWIND_FN_A,
  UNWIND_FN_B,
  UNWIND_LSDA,
  elfUnwindFixture,
} from "../../../src/native/elf/ElfUnwindTables.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const address = (value: number): string => `0x${value.toString(16)}`;

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("ELF unwind inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_elf_unwind_ranges and reads FDE ranges",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_elf_unwind_ranges",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-elf-unwind-mcp-");
      const path = join(root, "program");
      await writeFile(path, elfUnwindFixture());
      const response = await client.callTool({
        name: "inspect_elf_unwind_ranges",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_elf_unwind_ranges",
      ).outputSchema.parse(response.structuredContent);
      const report = evidence.normalized_result;
      expect(report.format).toBe("elf64");
      expect(report.ranges[0]).toMatchObject({
        start: address(UNWIND_FN_A),
        symbol: { text: "alpha", trust: "untrusted" },
      });
      expect(report.ranges[1]?.lsda).toEqual({
        address: address(UNWIND_LSDA),
        indirect: false,
      });
      expect(report.coverage.eh_frame_hdr_agreement).toBe("disagree");
      expect(report.limitations).toContain(
        "CFA instructions are counted but not evaluated.",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_elf_unwind_ranges",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_elf_unwind_ranges",
        arguments: { path: "program" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_elf_unwind_ranges" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest("pages one unwind range over MCP", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const root = await createTestTempDirectory("rea-elf-unwind-mcp-page-");
    const path = join(root, "program");
    await writeFile(path, elfUnwindFixture());
    const response = await client.callTool({
      name: "inspect_elf_unwind_ranges",
      arguments: { path, offset: 1, limit: 1 },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract(
      "inspect_elf_unwind_ranges",
    ).outputSchema.parse(response.structuredContent);
    expect(
      evidence.normalized_result.ranges.map((range) => range.start),
    ).toEqual([address(UNWIND_FN_B)]);
    expect(evidence.normalized_result.page).toMatchObject({
      offset: 1,
      limit: 1,
      returned: 1,
      total: 2,
      next_offset: null,
    });
  } finally {
    await session.close();
  }
});

mcpTest(
  "decodes an ELF32 big-endian unwind table over MCP",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-elf-unwind-mcp-be-");
      const path = join(root, "program");
      await writeFile(
        path,
        elfUnwindFixture({
          bits: 32,
          little: false,
          machine: 20,
          header: "match",
        }),
      );
      const response = await client.callTool({
        name: "inspect_elf_unwind_ranges",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_elf_unwind_ranges",
      ).outputSchema.parse(response.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        format: "elf32",
        byte_order: "big",
        machine: 20,
      });
      expect(evidence.normalized_result.coverage.eh_frame_hdr_agreement).toBe(
        "agree",
      );
    } finally {
      await session.close();
    }
  },
);
