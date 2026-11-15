import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfNote,
  elfNoteFixture,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

// Literal big-endian descriptors keep the expected values independent of the
// fixture's integer writers and the parser's byte-order branch.
const knownAbi = Buffer.from("00000000010203041020304080010203", "hex");
const unknownAbi = Buffer.from("01000000010203041020304080010203", "hex");
const extendedAbi = Buffer.concat([knownAbi, Buffer.from("01020304", "hex")]);
const shortAbi = knownAbi.subarray(0, 12);
const descriptorHash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

for (const { bits, ownership, machine } of [
  { bits: 32, ownership: "program", machine: 20 },
  { bits: 64, ownership: "section", machine: 21 },
] as const)
  cliTest(
    `preserves big-endian ELF${String(bits)} ABI facts through CLI and stdio MCP`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-elf-abi-endian-");
      const path = join(root, "selected.elf");
      const descriptors = [
        knownAbi,
        unknownAbi,
        shortAbi,
        extendedAbi,
        knownAbi,
      ];
      const notes = Buffer.concat([
        ...descriptors
          .slice(0, 4)
          .map((bytes) => elfNote("GNU", 1, bytes, false)),
        elfNote("OTHER", 1, knownAbi, false),
      ]);
      const bytes = elfNoteFixture({
        bits,
        ownership,
        machine,
        little: false,
        notes,
      });
      await writeFile(path, bytes);

      const output = await cli.run({
        arguments: ["inspect-elf-notes", path, "--json"],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const call = await cli.sharedMcpCall!();
      const response = await call("inspect_elf_notes", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);

      const schema = toolContract("inspect_elf_notes").outputSchema;
      const reports = [output.json, response.structuredContent].map((value) => {
        const evidence = schema.parse(value);
        expect(evidence.subject).toMatchObject({
          local_path: path,
          digest: { sha256: descriptorHash(bytes) },
        });
        const report = evidence.normalized_result;
        expect(report).toMatchObject({
          format: `elf${String(bits)}`,
          byte_order: "big",
          machine,
          coverage: {
            status: "complete",
            examined_tables: 1,
            examined_entries: 5,
          },
        });
        expect(report.entries).toHaveLength(5);
        expect(report.entries[0]?.gnu?.abi_tag).toEqual({
          os: 0,
          os_name: "linux",
          major: 0x01020304,
          minor: 0x10203040,
          subminor: 0x80010203,
        });
        expect(report.entries[1]?.gnu?.abi_tag).toEqual({
          os: 0x01000000,
          os_name: null,
          major: 0x01020304,
          minor: 0x10203040,
          subminor: 0x80010203,
        });
        // Unexpected lengths stay raw; no ABI values are invented or truncated.
        for (const index of [2, 3])
          expect(report.entries[index]?.gnu?.abi_tag).toBeNull();
        expect(report.entries[4]).toMatchObject({
          owner: "OTHER",
          type_name: "unknown",
          gnu: null,
        });
        for (const [index, descriptor] of descriptors.entries())
          expect(report.entries[index]?.descriptor).toMatchObject({
            bytes: descriptor.length,
            sha256: descriptorHash(descriptor),
          });
        return report;
      });
      expect(reports[0]).toEqual(reports[1]);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    },
  );
