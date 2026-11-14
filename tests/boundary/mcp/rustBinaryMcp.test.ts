import { rustBinarySchema } from "../../../src/domain/rust/rustBinary.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createRustImage,
  createRustHashOverflowImage,
} from "../../fixtures/rust/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Rust metadata must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_rust_binary and reads an embedded dependency list",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_rust_binary",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-rust-mcp-");
      const path = join(root, "sample.elf");
      await writeFile(path, createRustImage({ format: "elf" }));
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        response.structuredContent,
      );
      expect(
        rustBinarySchema.parse(evidence.normalized_result).auditable_metadata
          ?.packages,
      ).toEqual([
        expect.objectContaining({ name: "itoa", version: "1.0.18" }),
        expect.objectContaining({
          name: "sample",
          version: "0.1.0",
          root: true,
        }),
      ]);
      const missing = join(root, "plain.elf");
      await writeFile(
        missing,
        createRustImage({ format: "pe", omitSection: true }),
      );
      const absent = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path: missing },
      });
      expect(absent.isError).not.toBe(true);
      const absentEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(absent.structuredContent);
      expect(
        rustBinarySchema.parse(absentEvidence.normalized_result)
          .auditable_metadata,
      ).toBeNull();
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_rust_binary",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path: "sample" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_rust_binary" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "preserves dependency Evidence and compiler-prefix coverage through MCP",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-rust-mcp-");
      const path = join(root, "many-hashes.elf");
      await writeFile(path, createRustHashOverflowImage());
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        response.structuredContent,
      );
      const report = rustBinarySchema.parse(evidence.normalized_result);
      expect(report.auditable_metadata?.packages).toHaveLength(2);
      expect(report.rustc_commit?.coverage).toEqual({
        status: "partial",
        reason: "max_rustc_hashes",
        effective_limit: 64,
      });
    } finally {
      await session.close();
    }
  },
);
