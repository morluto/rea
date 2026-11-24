import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "../../fixtures/canonicalOutputSchema.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { afterAll, expect, it } from "vitest";
import { pythonPycSchema } from "../../../src/domain/python/pythonPyc.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "../../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";

const completePycEvidenceSchema = toolContract(
  "inspect_python_pyc",
).outputSchema.safeExtend({ normalized_result: pythonPycSchema });

const marshalInt64 = (value: bigint): Buffer => {
  const payload = Buffer.alloc(8);
  payload.writeBigInt64LE(value);
  return Buffer.concat([Buffer.from([0x49]), payload]);
};

const marshalInt32 = (value: number): Buffer => {
  const payload = Buffer.alloc(4);
  payload.writeInt32LE(value);
  return Buffer.concat([Buffer.from([0x69]), payload]);
};

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const connect = () =>
  createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("Python pyc inspection must not start a deep provider");
    }),
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: process.env.REA_MCP_MAX_INPUT_ELEMENTS,
      },
    },
    schemaValidator: schemaValidation,
  });

it("reads signed TYPE_INT64 constants and rejects a truncated payload", async () => {
  const { client, close } = await connect();
  try {
    const root = await createTestTempDirectory("rea-python-pyc-mcp-int64-");
    const path = join(root, "signed.pyc");
    await writeFile(
      path,
      Buffer.concat([
        pythonPycHeader(3531),
        marshalCode("py311", {
          consts: [
            ...[42n, -1n, -(1n << 63n), (1n << 63n) - 1n].map(marshalInt64),
            marshalInt32(-42),
          ],
        }),
      ]),
    );
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const { normalized_result } = completePycEvidenceSchema.parse(
      response.structuredContent,
    );
    expect(normalized_result.code_objects[0]?.consts).toEqual([
      { kind: "int", bits: 6, value: "42" },
      { kind: "int", bits: 1, value: "-1" },
      { kind: "int", bits: 64, value: "-9223372036854775808" },
      { kind: "int", bits: 63, value: "9223372036854775807" },
      { kind: "int", bits: 6, value: "-42" },
    ]);

    const truncatedPath = join(root, "truncated.pyc");
    await writeFile(
      truncatedPath,
      Buffer.concat([
        pythonPycHeader(3531),
        Buffer.from([0x49]),
        Buffer.alloc(7),
      ]),
    );
    const truncated = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path: truncatedPath },
    });
    expect(truncated.isError).toBe(true);
    expect(parseMcpToolError(truncated).error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_python_pyc",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
        reason: expect.stringContaining("64-bit integer"),
      },
    });
  } finally {
    await close();
  }
});

it("advertises inspect_python_pyc and reads nested code objects", async () => {
  const { client, close } = await connect();
  try {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_python_pyc",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    if (advertised === undefined)
      throw new Error("Missing inspect_python_pyc output schema");
    const outputSchema: Record<string, unknown> = canonicalOutputSchema(
      advertised.name,
    );
    const ajv = schemaValidation.assertions;
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const root = await createTestTempDirectory("rea-python-pyc-mcp-");
    const path = join(root, "sample.pyc");
    const nested = marshalCode("py311", {
      name: "inner",
      firstlineno: -7,
    });
    const bytes = Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", { firstlineno: -1, consts: [nested] }),
    ]);
    await writeFile(path, bytes);
    const response = await client.callTool(
      { name: "inspect_python_pyc", arguments: { path } },
      { toolDefinition: withCanonicalOutputSchema(advertised) },
    );
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = completePycEvidenceSchema.parse(
      response.structuredContent,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { identity: { format: "file", sha256 }, local_path: path },
      normalized_result: {
        artifact: { path, sha256, bytes: bytes.length },
        header: { magic: 3531, python_version: "3.12", code_layout: "py311" },
      },
    });
    expect(evidence.locations).toEqual([
      { kind: "artifact-path", path },
      { kind: "file-offset-range", start: 0, end: 16 },
      { kind: "file-offset-range", start: 16, end: bytes.length },
    ]);
    expect(evidence.normalized_result.code_objects[0]?.firstlineno).toBe(-1);
    expect(evidence.normalized_result.code_objects[1]?.name).toBe("inner");
    expect(evidence.normalized_result.code_objects[1]?.firstlineno).toBe(-7);
    expect(evidence.normalized_result.code_objects[0]?.consts).toContainEqual({
      kind: "code",
      name: "inner",
      firstlineno: -7,
    });
  } finally {
    await close();
  }
});

it("requires an absolute path for inspect_python_pyc", async () => {
  const { client, close } = await connect();
  try {
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path: "sample.pyc" },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_python_pyc" },
    });
  } finally {
    await close();
  }
});

it("advertised pyc output schema preserves historical signed fields", async () => {
  const { client, close } = await connect();
  try {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_python_pyc",
    );
    if (advertised === undefined)
      throw new Error("Missing inspect_python_pyc output schema");
    const root = await createTestTempDirectory("rea-python-pyc-mcp-flags-");
    const path = join(root, "ambiguous-3410.pyc");
    await writeFile(
      path,
      Buffer.concat([
        pythonPycHeader(3410),
        marshalCode("py38", { stacksize: 0xffffffff, flags: 0x80000000 }),
      ]),
    );
    const response = await client.callTool(
      { name: "inspect_python_pyc", arguments: { path } },
      { toolDefinition: withCanonicalOutputSchema(advertised) },
    );
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const { normalized_result } = completePycEvidenceSchema.parse(
      response.structuredContent,
    );
    expect(normalized_result.code_objects[0]).toMatchObject({
      stacksize: -1,
      flags: -0x80000000,
    });
    expect(normalized_result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("Magic 3410 is shared")]),
    );
  } finally {
    await close();
  }
});

it("rejects negative code fields for magics after constructor validation was added", async () => {
  const { client, close } = await connect();
  try {
    const root = await createTestTempDirectory("rea-python-pyc-mcp-signed-");
    const path = join(root, "negative-flags.pyc");
    await writeFile(
      path,
      Buffer.concat([
        pythonPycHeader(3411),
        marshalCode("py38", { flags: 0x80000000 }),
      ]),
    );
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_python_pyc",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
        reason: expect.stringContaining("co_flags is negative"),
      },
    });
  } finally {
    await close();
  }
});

it("reports an unknown pyc magic as unsupported", async () => {
  const { client, close } = await connect();
  try {
    const root = await createTestTempDirectory("rea-python-pyc-mcp-magic-");
    const path = join(root, "unknown.pyc");
    const bytes = pythonPycFixture("py311");
    bytes.writeUInt16LE(1, 0);
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_python_pyc" },
    });
  } finally {
    await close();
  }
});
