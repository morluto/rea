import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { v8CodeCacheSchema } from "../../../src/domain/v8/v8CodeCache.js";
import { v8CodeCacheFixture } from "../../../src/v8/V8CodeCache.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const completeEvidenceSchema = toolContract(
  "inspect_v8_code_cache",
).outputSchema.safeExtend({ normalized_result: v8CodeCacheSchema });

fileInspectionTest(
  "advertises inspect_v8_code_cache and reports a real container header",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_v8_code_cache",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-v8-mcp-");
    const path = join(root, "module.jsc");
    await writeFile(path, v8CodeCacheFixture("function m(){ return 1; } m();"));
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
    expect(report.limitations.join(" ")).toContain("byte-pattern observations");
  },
);

fileInspectionTest(
  "reports a foreign magic as an unsupported target rather than a parse",
  async ({ client }) => {
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
  },
);

fileInspectionTest(
  "reports a payload-length disagreement as a malformed target",
  async ({ client }) => {
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
      code: "unsupported_target",
      details: {
        operation: "inspect_v8_code_cache",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
        partial_observation: {
          kind: "file-snapshot-hash",
          path,
          bytes: corrupt.length,
          sha256: createHash("sha256").update(corrupt).digest("hex"),
        },
      },
    });
  },
);

fileInspectionTest(
  "reports details.limit for max_file_bytes refusals and succeeds when raised to required_value",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-v8-mcp-limit-");
    const path = join(root, "module.jsc");
    const bytes = v8CodeCacheFixture("function m(){ return 2; } m();");
    await writeFile(path, bytes);

    const refused = await client.callTool({
      name: "inspect_v8_code_cache",
      arguments: { path, max_file_bytes: 36 },
    });
    expect(refused.isError).toBe(true);
    const parsed = parseMcpToolError(refused).error;
    expect(parsed).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_v8_code_cache",
        limit: {
          control_kind: "parameter",
          parameter: "max_file_bytes",
          effective_value: 36,
          unit: "bytes",
          minimum: 36,
          maximum: 67_108_864,
          default_value: 33_554_432,
          applies_at: "next_call",
          required_value: bytes.length,
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_v8_code_cache",
          control: "max_file_bytes",
          effective_value: 36,
          unit: "bytes",
          range: { minimum: 36, maximum: 67_108_864 },
          default_value: 33_554_432,
          required_value: bytes.length,
        },
      },
    });
    expect(parsed.details?.limit).not.toHaveProperty("cli_flag");
    expect(parsed.remediation?.action).toContain("max_file_bytes");
    expect(parsed.remediation?.action).toContain(
      `at least ${String(bytes.length)} bytes`,
    );

    const admitted = await client.callTool({
      name: "inspect_v8_code_cache",
      arguments: { path, max_file_bytes: bytes.length },
    });
    expect(admitted.isError, JSON.stringify(admitted.content)).not.toBe(true);
    const evidence = completeEvidenceSchema.parse(admitted.structuredContent);
    expect(evidence.normalized_result.artifact.bytes).toBe(bytes.length);
  },
);

fileInspectionTest(
  "reports details.limit without required_value for max_strings refusals",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-v8-mcp-strings-");
    const path = join(root, "synthetic.jsc");
    const payload = Buffer.from("aaaa\0bbbb");
    const bytes = Buffer.concat([
      v8CodeCacheFixture().subarray(0, 32),
      payload,
    ]);
    bytes.writeUInt32LE(payload.length, 20);
    await writeFile(path, bytes);

    const refused = await client.callTool({
      name: "inspect_v8_code_cache",
      arguments: { path, max_strings: 1, min_string_bytes: 4 },
    });
    expect(refused.isError).toBe(true);
    const parsed = parseMcpToolError(refused).error;
    expect(parsed).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_v8_code_cache",
        limit: {
          control_kind: "parameter",
          parameter: "max_strings",
          effective_value: 1,
          unit: "count",
          minimum: 1,
          maximum: 65_536,
          default_value: 4096,
          applies_at: "next_call",
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_v8_code_cache",
          control: "max_strings",
          effective_value: 1,
          unit: "count",
          range: { minimum: 1, maximum: 65_536 },
          default_value: 4096,
        },
      },
    });
    expect(parsed.details?.limit).not.toHaveProperty("required_value");
    expect(parsed.details?.limit).not.toHaveProperty("cli_flag");
  },
);
