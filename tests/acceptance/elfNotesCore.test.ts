import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  coreAuxvNote,
  coreFileNote,
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
          file_ofs: 0n,
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
      ],
      64,
      true,
    ),
  ]);

const assertCoreEntries = (entries: unknown[]): void => {
  expect(entries).toHaveLength(4);
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
            file_offset_pages: "0x0",
            path: "/lib/x86_64-linux-gnu/libc.so.6",
            path_hex: Buffer.from("/lib/x86_64-linux-gnu/libc.so.6").toString(
              "hex",
            ),
          },
        ],
      },
    },
  });
  expect(entries[2]).toMatchObject({
    owner: "CORE",
    type: 0x53494749,
    type_name: "core_siginfo",
    gnu: null,
    core: {
      siginfo: { signo: 11, errno: 0, code: 1 },
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
      ],
    },
  });
};

cliTest(
  "decodes Linux core dump notes through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-core-notes-");
    const path = join(root, "core.elf");
    const notes = buildCoreNotes();
    const bytes = elfNoteFixture({
      bits: 64,
      little: true,
      type: 4,
      ownership: "program",
      notes,
    });
    await writeFile(path, bytes);

    const output = await cli.sharedCliRun!({
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
        digest: { sha256: descriptorHash(bytes) },
      });
      const report = evidence.normalized_result;
      expect(report).toMatchObject({
        format: "elf64",
        byte_order: "little",
        machine: 62,
        coverage: {
          status: "complete",
          examined_tables: 1,
          examined_entries: 4,
        },
      });
      assertCoreEntries(report.entries);
    }
  },
);

const linuxPrpsinfo32Descriptor = (little: boolean): Buffer => {
  const descriptor = Buffer.alloc(128);
  descriptor[0] = 1;
  const write = little
    ? descriptor.writeUInt32LE.bind(descriptor)
    : descriptor.writeUInt32BE.bind(descriptor);
  write(70001, 8);
  write(90002, 12);
  write(1234, 16);
  write(12, 20);
  write(4321, 24);
  write(5678, 28);
  descriptor.write("core-probe", 32, "latin1");
  descriptor.write("core-probe --flag", 48, "latin1");
  return descriptor;
};

cliTest.for([
  { name: "MIPS little", machine: 8, byteOrder: "little" },
  { name: "MIPS big", machine: 8, byteOrder: "big" },
  { name: "PowerPC big", machine: 20, byteOrder: "big" },
  { name: "RISC-V little", machine: 243, byteOrder: "little" },
] as const)(
  "decodes Linux ELF32 process identity through CLI and MCP ($name)",
  async ({ machine, byteOrder }, { cli }) => {
    const root = await createTestTempDirectory("rea-elf-prpsinfo32-core-");
    const path = join(root, "core.elf");
    const little = byteOrder === "little";
    const descriptor = linuxPrpsinfo32Descriptor(little);
    const bytes = elfNoteFixture({
      bits: 32,
      machine,
      little,
      type: 4,
      ownership: "program",
      notes: Buffer.concat([
        elfNote("CORE", 3, descriptor, little),
        elfNote("CORE", 3, descriptor.subarray(0, 124), little),
      ]),
    });
    await writeFile(path, bytes);

    const output = await cli.sharedCliRun!({
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
        digest: { sha256: descriptorHash(bytes) },
      });
      const report = evidence.normalized_result;
      expect(report).toMatchObject({
        format: "elf32",
        byte_order: byteOrder,
        machine,
        coverage: { status: "complete", examined_entries: 2 },
      });
      expect(report.entries[0]?.core?.prpsinfo).toEqual({
        state: 1,
        uid: 70001,
        gid: 90002,
        pid: 1234,
        ppid: 12,
        pgrp: 4321,
        sid: 5678,
        filename: "core-probe",
        psargs: "core-probe --flag",
      });
      expect(report.entries[1]).toMatchObject({
        type_name: "core_prpsinfo",
        descriptor: {
          bytes: 124,
          sha256: descriptorHash(descriptor.subarray(0, 124)),
        },
        core: null,
      });
    }
  },
);
