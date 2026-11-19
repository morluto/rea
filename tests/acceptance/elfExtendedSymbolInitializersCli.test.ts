import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  EXTENDED_CTOR_SECTION,
  extendedSymbolInitializers,
} from "../../src/native/initializers/ExtendedSymbolInitializers.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = toolContract("inspect_native_initializers");

cliTest(
  "retains extended ELF section coordinates through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-extended-symbol-initializers-",
    );
    const call = await cli.sharedMcpCall!();
    for (const bits of [32, 64] as const) {
      const bytes = extendedSymbolInitializers(bits);
      const path = join(root, `elf${bits}.o`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-native-initializers", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const response = await call("inspect_native_initializers", { path });
      expect(response.isError).not.toBe(true);
      for (const value of [result.json, response.structuredContent]) {
        const evidence = contract.outputSchema.parse(value);
        const report = evidence.normalized_result;
        expect(report).toMatchObject({
          status: "parsed",
          bits,
          coverage: { status: "complete", returned_entries: 2 },
          artifact: {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        });
        expect(report.entries[0]).toMatchObject({
          value_va: "0x0",
          value_file_offset: 0x100,
          section: { name: ".text.high_ctor" },
          symbol: { name: "high_ctor" },
          resolution: "symbol_addend",
        });
        expect(report.entries[1]).toMatchObject({
          value_file_offset: 0x110,
          section: { name: ".text.local_ctor" },
          symbol: { name: "local_ctor" },
        });
        expect(evidence.subject).toMatchObject({
          local_path: path,
          identity: { sha256: report.artifact.sha256 },
        });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
      const headerSize = bits === 64 ? 64 : 40;
      for (const shape of [
        "missing",
        "duplicate",
        "truncated",
        "outside",
      ] as const) {
        const broken = Buffer.from(bytes);
        const header = 0x1000 + 6 * headerSize;
        if (shape === "missing") broken.writeUInt32LE(0, header + 4);
        else if (shape === "duplicate")
          broken.copy(
            broken,
            0x1000 + 8 * headerSize,
            header,
            header + headerSize,
          );
        else if (shape === "truncated") {
          if (bits === 64) broken.writeBigUInt64LE(4n, header + 32);
          else broken.writeUInt32LE(4, header + 20);
        } else broken.writeUInt32LE(EXTENDED_CTOR_SECTION + 1, 0x384);
        const brokenPath = join(root, `elf${bits}-${shape}.o`);
        await writeFile(brokenPath, broken);
        const response = await call("inspect_native_initializers", {
          path: brokenPath,
        });
        expect(response.isError).not.toBe(true);
        const report = contract.outputSchema.parse(
          response.structuredContent,
        ).normalized_result;
        expect(report.status, shape).toBe("incomplete");
        expect(report.entries[0], shape).toMatchObject({
          value_va: null,
          value_file_offset: null,
          section: null,
          resolution: "unresolved",
        });
        // A bad extension must not erase an independent, ordinary symbol's facts.
        expect(report.entries[1], shape).toMatchObject({
          value_file_offset: 0x110,
          section: { name: ".text.local_ctor" },
          symbol: { name: "local_ctor" },
        });
        expect((await readFile(brokenPath)).equals(broken)).toBe(true);
      }
      // The same numeric word is a special marker in st_shndx, not an actual section.
      for (const special of [0xfff1, 0xfff2]) {
        const reserved = Buffer.from(bytes);
        const symbol = 0x300 + (bits === 64 ? 24 : 16);
        reserved.writeUInt16LE(special, symbol + (bits === 64 ? 6 : 14));
        const specialPath = join(root, `elf${bits}-${special}.o`);
        await writeFile(specialPath, reserved);
        const response = await call("inspect_native_initializers", {
          path: specialPath,
        });
        expect(response.isError).not.toBe(true);
        const report = contract.outputSchema.parse(
          response.structuredContent,
        ).normalized_result;
        expect(report.entries[0]).toMatchObject({
          value_va: special === 0xfff1 ? "0x0" : null,
          value_file_offset: null,
          section: null,
          resolution: special === 0xfff1 ? "symbol_addend" : "unresolved",
        });
        expect(report.entries[1]?.value_file_offset).toBe(0x110);
        expect((await readFile(specialPath)).equals(reserved)).toBe(true);
      }
    }
  },
);
