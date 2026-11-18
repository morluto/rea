import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { riscvInitializers } from "../../src/native/initializers/RiscvInitializers.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = toolContract("inspect_native_initializers");

cliTest(
  "recovers RV32/RV64 constructors through CLI and stdio MCP without running the image",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-riscv-initializers-");
    const call = await cli.sharedMcpCall!();
    for (const bits of [32, 64] as const) {
      const path = join(root, `rv${bits}.so`);
      const bytes = riscvInitializers(bits);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-native-initializers", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const response = await call("inspect_native_initializers", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      for (const value of [result.json, response.structuredContent]) {
        const evidence = contract.outputSchema.parse(value);
        const report = evidence.normalized_result;
        expect(report).toMatchObject({
          status: "parsed",
          architecture: "riscv",
          bits,
          coverage: {
            status: "complete",
            examined_entries: 4,
            returned_entries: 4,
          },
          artifact: {
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        });
        expect(
          report.entries.map((entry) => [
            entry.kind,
            entry.value_va,
            entry.resolution,
            entry.symbol?.name,
          ]),
        ).toEqual([
          ["init_array", "0x100", "relative_addend", "local_ctor"],
          ["init_array", "0x100", "symbol_addend", "local_ctor"],
          ["init_array", null, "unresolved_import", "external_ctor"],
          ["fini_array", "0x100", "relr", "local_ctor"],
        ]);
        expect(evidence.subject).toMatchObject({
          local_path: path,
          identity: { sha256: report.artifact.sha256 },
        });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
      // Unknown or differently sized writes must not expose the stored zero.
      for (const kind of [0x7f, bits === 64 ? 1 : 2]) {
        const unknown = Buffer.from(bytes);
        if (bits === 64) unknown.writeBigUInt64LE(BigInt(kind), 0x408);
        else unknown.writeUInt32LE(kind, 0x404);
        const unknownPath = join(root, `rv${bits}-unknown-${kind}.so`);
        await writeFile(unknownPath, unknown);
        const refused = await call("inspect_native_initializers", {
          path: unknownPath,
        });
        expect(refused.isError).not.toBe(true);
        const report = contract.outputSchema.parse(
          refused.structuredContent,
        ).normalized_result;
        expect(report.status).toBe("incomplete");
        expect(report.entries[0]).toMatchObject({
          value_va: null,
          resolution: "unresolved",
        });
        expect((await readFile(unknownPath)).equals(unknown)).toBe(true);
      }
    }
  },
);
