import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peRichHeaderImage,
  RICH_FIXTURE_ENTRIES,
} from "../../src/native/pe/PeRichHeader.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const report = (value: unknown) =>
  toolContract("inspect_pe_rich_header").outputSchema.parse(value)
    .normalized_result;

cliTest(
  "reads the same Rich header through the CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-rich-cli-");
    const call = await cli.sharedMcpCall!();
    const path = join(root, "app.exe");
    const bytes = peRichHeaderImage({ plus: false });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-rich-header", "app.exe", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const response = await call("inspect_pe_rich_header", { path });
    expect(response.isError).not.toBe(true);
    for (const value of [result.json, response.structuredContent]) {
      const parsed = report(value);
      expect(parsed.format).toBe("pe32");
      expect(parsed.rich_header).toMatchObject({
        state: "present",
        checksum: { matches: true },
        entries: RICH_FIXTURE_ENTRIES.map(({ productId, build, count }) => ({
          product_id: productId,
          build,
          count,
        })),
      });
    }
    expect(
      toolContract("inspect_pe_rich_header").outputSchema.parse(result.json)
        .subject?.local_path,
    ).toBe(path);
    expect((await readFile(path)).equals(bytes)).toBe(true);

    await writeFile(path, Buffer.from("ZZ not a PE image"));
    const rejected = await cli.run({
      arguments: ["inspect-pe-rich-header", path, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_rich_header" },
    });
    const mcpRejected = await call("inspect_pe_rich_header", { path });
    expect(mcpRejected.isError).toBe(true);
    expect(parseMcpToolError(mcpRejected)).toEqual({ error: rejected.json });
  },
);

cliTest("fails closed at the entry budget", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-rich-budget-");
  const path = join(root, "app.exe");
  await writeFile(path, peRichHeaderImage());
  const result = await cli.run({
    arguments: ["inspect-pe-rich-header", path, "--max-entries", "2", "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    remediation: {
      action: expect.stringContaining("Raise max_entries above 2"),
    },
  });
  const retried = await cli.run({
    arguments: ["inspect-pe-rich-header", path, "--max-entries", "3", "--json"],
  });
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(report(retried.json).rich_header.state).toBe("present");
});
