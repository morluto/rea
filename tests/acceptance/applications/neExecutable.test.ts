import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { neExecutableSchema } from "../../../src/domain/native/neExecutable.js";
import { neFixture } from "../../../src/native/ne/NeExecutable.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const contract = toolContract("inspect_ne_executable");

cliTest(
  "inspects an NE image through compiled CLI and real stdio MCP without an active target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ne-acceptance-");
    const { client } = await connectLocalToolsMcp();
    const inventory = await client.listTools();
    expect(inventory.tools).toContainEqual(
      expect.objectContaining({ name: contract.name }),
    );

    const fixture = neFixture();
    const path = join(root, "sample.dll");
    await writeFile(path, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-ne-executable", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(fileIdentity(evidence.subject)).toMatchObject({
      format: "ne",
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    const report = neExecutableSchema.parse(evidence.normalized_result);
    expect(report).toMatchObject({
      module_name: { name: "SAMPLE" },
      module_references: [{ name: "KERNEL" }, { name: "USER" }],
      coverage: { status: "complete", examined_rows: 13 },
    });

    const response = await client.callTool({
      name: contract.name,
      arguments: { path },
    });
    expect(response.isError).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    expect((await readFile(path)).equals(fixture.bytes)).toBe(true);

    const missing = join(root, "missing.dll");
    const failed = await cli.run({
      arguments: ["inspect-ne-executable", missing, "--json"],
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "inspect_ne_executable",
        issues: [{ path: ["path"], reason: "invalid_value" }],
      },
    });
    const rejected = await client.callTool({
      name: contract.name,
      arguments: { path: missing },
    });
    expect(rejected.isError).toBe(true);
    expect(parseMcpToolError(rejected)).toEqual({ error: failed.json });

    // Bytes that are not an NE image are a target refusal, not caller input.
    const malformed = join(root, "malformed.dll");
    await writeFile(malformed, Buffer.from("not an NE image"));
    const refused = await cli.run({
      arguments: ["inspect-ne-executable", malformed, "--json"],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      retryable: false,
      details: {
        operation: "inspect_ne_executable",
        path: malformed,
        format_failure: "malformed",
      },
    });
    expect(refused.json).not.toHaveProperty("details.issues");

    for (const arguments_ of [
      { path, max_rows: 1 },
      { path: "relative.dll" },
      { path, extra: true },
    ]) {
      const invalid = await client.callTool({
        name: contract.name,
        arguments: arguments_,
      });
      expect(invalid.isError).toBe(true);
      expect(
        contract.outputSchema.safeParse(invalid.structuredContent).success,
      ).toBe(false);
    }
    await client.ping();
  },
  30_000,
);
