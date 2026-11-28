import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { CANONICALIZE_TOOL_CONTRACTS } from "../../../src/contracts/canonicalize/canonicalizeToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const contract = CANONICALIZE_TOOL_CONTRACTS.find(
  (candidate) => candidate.name === "canonicalize_artifact",
);
if (contract === undefined)
  throw new Error("Missing canonicalize_artifact contract");

const lebU32 = (value: number): Buffer => {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return Buffer.from(out);
};
const section = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([id]), lebU32(payload.length), payload]);
const customSection = (name: string, content: Buffer): Buffer => {
  const nameBytes = Buffer.from(name, "utf8");
  return section(
    0,
    Buffer.concat([lebU32(nameBytes.length), nameBytes, content]),
  );
};
const decoyWasm = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    section(1, Buffer.from([0x01, 0x60, 0x00, 0x00])),
    customSection("bla.enclave.manifest", Buffer.alloc(8192, 0x41)),
  ]);

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Canonicalization must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises canonicalize_artifact and drops non-semantic WASM custom sections",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "canonicalize_artifact",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-canonicalize-mcp-");
      const path = join(root, "core.wasm");
      const bytes = decoyWasm();
      await writeFile(path, bytes);
      const response = await client.callTool({
        name: "canonicalize_artifact",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = contract.outputSchema.parse(response.structuredContent);
      const facts = evidence.normalized_result;
      expect(facts.detected_format).toBe("wasm");
      expect(facts.core.some((fact) => fact.name === "type")).toBe(true);
      expect(
        facts.collapsed.some(
          (fact) =>
            fact.name === "bla.enclave.manifest" &&
            fact.classification === "non-semantic-padding",
        ),
      ).toBe(true);
      // The pass never mutates the target.
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for canonicalize_artifact",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "canonicalize_artifact",
        arguments: { path: "core.wasm" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "canonicalize_artifact" },
      });
    } finally {
      await session.close();
    }
  },
);
