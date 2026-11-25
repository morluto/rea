import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peUnwindImage,
  unwindInfo,
} from "../../src/native/pe/PeUnwindRanges.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  expectAdapterErrorParity,
  parseMcpToolError,
} from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const primary = { begin: 0x1000, end: 0x1100, unwind: 0x2000 };
const image = () =>
  peUnwindImage({
    entries: [primary, { begin: 0x1100, end: 0x1180, unwind: 0x2100 }],
    blobs: [
      { rva: 0x2000, bytes: unwindInfo(0, 2) },
      { rva: 0x2100, bytes: unwindInfo(0x4, 0, primary) },
    ],
  });

cliTest(
  "reads x64 exception-directory ranges identically over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-unwind-cli-");
    const path = join(root, "app.exe");
    const bytes = image();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-pe-unwind-ranges",
        path,
        "--kind",
        "chained",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_pe_unwind_ranges",
    ).outputSchema.parse(result.json);
    expect(evidence.operation).toBe("inspect_pe_unwind_ranges");
    expect(evidence.normalized_result.coverage).toMatchObject({
      status: "complete",
      total_entries: 2,
      primary_entries: 1,
      chained_entries: 1,
    });
    expect(evidence.normalized_result.entries).toMatchObject([
      {
        index: 1,
        kind: "chained",
        parent: { begin_rva: "0x1000", index: 0 },
        primary_index: 0,
      },
    ]);

    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_pe_unwind_ranges", {
      path,
      kind: "chained",
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const mcpEvidence = toolContract(
      "inspect_pe_unwind_ranges",
    ).outputSchema.parse(response.structuredContent);
    expect(mcpEvidence.normalized_result).toEqual(evidence.normalized_result);
    expect((await readFile(path)).equals(bytes)).toBe(true);

    // A cut-off directory is a refusal on both adapters, with the same error.
    const truncated = join(root, "truncated.exe");
    await writeFile(truncated, bytes.subarray(0, 0x2400 + 6));
    const refused = await cli.run({
      arguments: ["inspect-pe-unwind-ranges", truncated, "--json"],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      details: { operation: "inspect_pe_unwind_ranges", path: truncated },
    });
    const mcpRefused = await call("inspect_pe_unwind_ranges", {
      path: truncated,
    });
    expect(mcpRefused.isError).toBe(true);
    expectAdapterErrorParity(
      parseMcpToolError(mcpRefused).error,
      refused.json,
      "inspect_pe_unwind_ranges",
    );
  },
);
