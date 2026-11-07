import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Raw byte inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

const fileWithPeSignature = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-raw-bytes-mcp-");
  const path = join(root, "data.bin");
  const bytes = Buffer.alloc(256, 0xaa);
  Buffer.from([
    0x50, 0x45, 0x00, 0x00, 0x64, 0x86, 0x06, 0x00, 0x6c, 0x7d, 0xe9, 0x6a,
    0x00, 0x00, 0x00, 0x00,
  ]).copy(bytes, 0x78);
  await writeFile(path, bytes);
  return path;
};

mcpTest(
  "advertises both raw byte tools and distinguishes raw offsets from addresses",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ["inspect_raw_bytes", "search_raw_bytes"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.annotations).toMatchObject({ idempotentHint: true });
        expect(tool?.description).toMatch(/RAW FILE OFFSET/u);
        expect(tool?.description).toMatch(/not a program memory address/u);
      }
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reads a raw file slice and returns the exact xxd line",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const path = await fileWithPeSignature();
      const response = await client.callTool({
        name: "inspect_raw_bytes",
        arguments: { path, offset: 0x78, length: 16 },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_raw_bytes").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.hex_dump).toBe(
        "00000078: 5045 0000 6486 0600 6c7d e96a 0000 0000  PE..d...l}.j....",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest("searches a raw file and reports the file offset", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const path = await fileWithPeSignature();
    const response = await client.callTool({
      name: "search_raw_bytes",
      arguments: { path, pattern: "50 45 00 00" },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract("search_raw_bytes").outputSchema.parse(
      response.structuredContent,
    );
    expect(
      evidence.normalized_result.matches.map(({ offset }) => offset),
    ).toEqual([120]);
  } finally {
    await session.close();
  }
});

mcpTest(
  "rejects an oversized read, an unconstrained pattern, a read past EOF and a relative path",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const path = await fileWithPeSignature();
      const cases = [
        {
          name: "inspect_raw_bytes",
          arguments: { path, offset: 0, length: 4097 },
        },
        { name: "search_raw_bytes", arguments: { path, pattern: "?? ??" } },
        {
          name: "inspect_raw_bytes",
          arguments: { path, offset: 250, length: 16 },
        },
        {
          name: "inspect_raw_bytes",
          arguments: { path: "data.bin", offset: 0, length: 4 },
        },
      ];
      for (const call of cases) {
        const response = await client.callTool(call);
        expect(response.isError, call.name).toBe(true);
        expect(parseMcpToolError(response).error).toMatchObject({
          details: { operation: call.name },
        });
      }
    } finally {
      await session.close();
    }
  },
);
