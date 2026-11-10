import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { v8CodeCacheSchema } from "../../../src/domain/v8/v8CodeCache.js";
import { v8CodeCacheFixture } from "../../../src/v8/V8CodeCache.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const completeEvidenceSchema = toolContract(
  "inspect_v8_code_cache",
).outputSchema.safeExtend({ normalized_result: v8CodeCacheSchema });

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("V8 code cache inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_v8_code_cache and reports a real container header",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_v8_code_cache",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-v8-mcp-");
      const path = join(root, "module.jsc");
      await writeFile(
        path,
        v8CodeCacheFixture("function m(){ return 1; } m();"),
      );
      const response = await client.callTool({
        name: "inspect_v8_code_cache",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeEvidenceSchema.parse(response.structuredContent);
      const report = evidence.normalized_result;
      expect(report.header.magic_build_stable).toBe(0xc0de);
      expect(report.header.header_bytes).toBe(32);
      expect(report.payload.offset).toBe(32);
      expect(report.payload.offset + report.payload.bytes).toBe(
        report.artifact.bytes,
      );
      expect(report.limitations.join(" ")).toContain(
        "byte-pattern observations",
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_v8_code_cache",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_v8_code_cache",
        arguments: { path: "module.jsc" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_v8_code_cache" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a foreign magic as an unsupported target rather than a parse",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-v8-unsupported-");
      const path = join(root, "not-a-cache.jsc");
      const foreign = Buffer.from(v8CodeCacheFixture());
      foreign.writeUInt32LE(0xdeadbeef, 0);
      await writeFile(path, foreign);
      const response = await client.callTool({
        name: "inspect_v8_code_cache",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        details: { operation: "inspect_v8_code_cache" },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports a payload-length disagreement as invalid input",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const root = await createTestTempDirectory("rea-v8-malformed-");
      const path = join(root, "truncated.jsc");
      const corrupt = Buffer.from(v8CodeCacheFixture());
      corrupt.writeUInt32LE(corrupt.readUInt32LE(20) + 8, 20);
      await writeFile(path, corrupt);
      const response = await client.callTool({
        name: "inspect_v8_code_cache",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_v8_code_cache",
          partial_observation: {
            kind: "file-snapshot-hash",
            path,
            bytes: corrupt.length,
            sha256: createHash("sha256").update(corrupt).digest("hex"),
          },
        },
      });
    } finally {
      await session.close();
    }
  },
);
