import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { elf32RelAddends } from "../fixtures/elf32RelAddends.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "keeps GNU i386 REL constructor addends within their 32-bit word through CLI Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-rel-addends-");
    const path = join(root, "constructor.o");
    const bytes = elf32RelAddends();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-native-initializers", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
      (candidate) => candidate.name === "inspect_native_initializers",
    );
    if (contract === undefined)
      throw new Error("Missing native initializer contract");
    const report = contract.outputSchema.parse(result.json).normalized_result;
    expect(report).toMatchObject({ status: "parsed", bits: 32, elf_type: 1 });
    expect(report.artifact).toMatchObject({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    // GNU ld resolves these to 0x1000, 0x1002, 0x1001 when .text is at 0x1000;
    // this ET_REL view retains their section-relative 0, 2, 1 identities.
    expect(
      report.entries.map(
        ({ value_va, value_file_offset, resolution, symbol }) => ({
          value_va,
          value_file_offset,
          resolution,
          symbol: symbol?.name ?? null,
        }),
      ),
    ).toEqual([
      {
        value_va: "0x0",
        value_file_offset: 0x80,
        resolution: "symbol_addend",
        symbol: null,
      },
      {
        value_va: "0x2",
        value_file_offset: 0x82,
        resolution: "symbol_addend",
        symbol: null,
      },
      {
        value_va: "0x1",
        value_file_offset: 0x81,
        resolution: "symbol_addend",
        symbol: "marker",
      },
    ]);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
