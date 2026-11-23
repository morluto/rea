import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  coreAuxvNote,
  coreFileNote,
  elf32ProcessIdentityFixture,
  corePrpsinfoNote,
  coreSiginfoNote,
  elfNote,
  elfNoteFixture,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const descriptorHash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const buildCoreNotes = (): Buffer =>
  Buffer.concat([
    corePrpsinfoNote({
      bits: 64,
      little: true,
      state: 0,
      sname: "R",
      pid: 31337,
      ppid: 1,
      pgrp: 31337,
      sid: 31337,
      uid: 1000,
      gid: 1000,
      fname: "target-service",
      psargs: "/opt/target-service --worker 1",
    }),
    coreFileNote(
      [
        {
          start: 0x555555554000n,
          end: 0x555555558000n,
          file_ofs: 0n,
          path: "/opt/target-service",
        },
        {
          start: 0x7ffff7dc0000n,
          end: 0x7ffff7de0000n,
          file_ofs: 10n,
          path: "/lib/x86_64-linux-gnu/libc.so.6",
        },
      ],
      4096,
      64,
      true,
    ),
    coreSiginfoNote(11, 1, 0, true),
    coreAuxvNote(
      [
        [6, 4096n],
        [3, 0x555555554040n],
        [999, 0x1234n],
      ],
      64,
      true,
    ),
  ]);

const assertCoreEntries = (entries: unknown[]): void => {
  expect(entries[0]).toMatchObject({
    owner: "CORE",
    type: 3,
    type_name: "core_prpsinfo",
    gnu: null,
    core: {
      prpsinfo: {
        state: 0,
        pid: 31337,
        ppid: 1,
        pgrp: 31337,
        sid: 31337,
        uid: 1000,
        gid: 1000,
        filename: "target-service",
        psargs: "/opt/target-service --worker 1",
      },
      file: null,
      siginfo: null,
      auxv: null,
    },
  });
  expect(entries[1]).toMatchObject({
    owner: "CORE",
    type: 0x46494c45,
    type_name: "core_file",
    gnu: null,
    core: {
      file: {
        count: 2,
        page_size: 4096,
        mappings: [
          {
            start_address: "0x555555554000",
            end_address: "0x555555558000",
            file_offset_pages: "0x0",
            path: "/opt/target-service",
            path_hex: Buffer.from("/opt/target-service").toString("hex"),
          },
          {
            start_address: "0x7ffff7dc0000",
            end_address: "0x7ffff7de0000",
            file_offset_pages: "0xa",
            path: "/lib/x86_64-linux-gnu/libc.so.6",
            path_hex: Buffer.from("/lib/x86_64-linux-gnu/libc.so.6").toString(
              "hex",
            ),
          },
        ],
      },
      prpsinfo: null,
      siginfo: null,
      auxv: null,
    },
  });
  expect(entries[2]).toMatchObject({
    owner: "CORE",
    type: 0x53494749,
    type_name: "core_siginfo",
    gnu: null,
    core: {
      siginfo: { signo: 11, errno: 0, code: 1 },
      prpsinfo: null,
      file: null,
      auxv: null,
    },
  });
  expect(entries[3]).toMatchObject({
    owner: "CORE",
    type: 6,
    type_name: "core_auxv",
    gnu: null,
    core: {
      auxv: [
        { type: 6, type_name: "AT_PAGESZ", value: "0x1000" },
        { type: 3, type_name: "AT_PHDR", value: "0x555555554040" },
        { type: 999, type_name: null, value: "0x1234" },
      ],
      prpsinfo: null,
      file: null,
      siginfo: null,
    },
  });
};

cliTest(
  "decodes Linux core dump notes through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-core-notes-");
    const path = join(root, "core.elf");
    const mappingsWithoutPaths = Buffer.alloc(16 + 40 * 24);
    mappingsWithoutPaths.writeBigUInt64LE(40n, 0);
    mappingsWithoutPaths.writeBigUInt64LE(4096n, 8);
    const notes = Buffer.concat([
      elfNote("CORE", 0x46494c45, mappingsWithoutPaths),
      buildCoreNotes(),
    ]);
    const bytes = elfNoteFixture({
      bits: 64,
      little: true,
      type: 4,
      ownership: "program",
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
    for (const raw of [output.json, response.structuredContent]) {
      const evidence = schema.parse(raw);
      expect(evidence.subject).toMatchObject({
        local_path: path,
        identity: { sha256: descriptorHash(bytes) },
      });
      const report = evidence.normalized_result;
      expect(report).toMatchObject({
        format: "elf64",
        byte_order: "little",
        machine: 62,
        coverage: {
          status: "complete",
          examined_tables: 1,
          examined_entries: 5,
        },
      });
      expect(report.entries[0]).toMatchObject({
        type_name: "core_file",
        descriptor: {
          bytes: mappingsWithoutPaths.length,
          sha256: descriptorHash(mappingsWithoutPaths),
        },
        core: null,
      });
      assertCoreEntries(report.entries.slice(1));
    }
  },
);

cliTest.for([
  { name: "MIPS big", machine: 8, little: false, idWidth: 4 },
  { name: "SuperH little", machine: 42, little: true, idWidth: 2 },
] as const)(
  "decodes Linux ELF32 process identity through CLI and MCP ($name)",
  async ({ machine, little, idWidth }, { cli }) => {
    const root = await createTestTempDirectory("rea-elf-prpsinfo32-core-");
    const path = join(root, "core.elf");
    const { bytes, shortened, expected } = elf32ProcessIdentityFixture(
      machine,
      little,
      idWidth,
    );
    await writeFile(path, bytes);

    const output = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_elf_notes", { path });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);

    const schema = toolContract("inspect_elf_notes").outputSchema;
    for (const raw of [output.json, response.structuredContent]) {
      const evidence = schema.parse(raw);
      expect(evidence.subject).toMatchObject({
        local_path: path,
        identity: { sha256: descriptorHash(bytes) },
      });
      const report = evidence.normalized_result;
      expect(report).toMatchObject({
        format: "elf32",
        byte_order: little ? "little" : "big",
        machine,
        coverage: { status: "complete", examined_entries: 2 },
      });
      expect(report.entries[0]?.core?.prpsinfo).toEqual(expected);
      expect(report.entries[1]).toMatchObject({
        type_name: "core_prpsinfo",
        descriptor: {
          bytes: shortened.length,
          sha256: descriptorHash(shortened),
        },
        core: null,
      });
    }
  },
);
