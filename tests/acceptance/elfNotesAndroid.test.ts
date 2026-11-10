import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import {
  androidIdentNote,
  elfNote,
  elfNoteFixture,
  gnuBuildIdNote,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const inspectElfNotesContract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
  (
    candidate,
  ): candidate is Extract<
    (typeof BINARY_DIAGNOSTICS_TOOL_CONTRACTS)[number],
    { readonly name: "inspect_elf_notes" }
  > => candidate.name === "inspect_elf_notes",
);
if (inspectElfNotesContract === undefined)
  throw new Error("Missing inspect_elf_notes contract");

for (const target of [
  {
    label: "little-endian ELF64",
    bits: 64 as const,
    little: true,
    machine: 183,
  },
  { label: "big-endian ELF32", bits: 32 as const, little: false, machine: 8 },
])
  cliTest(
    `decodes ${target.label} Android .note.android.ident through CLI and stdio MCP`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-elf-android-notes-");
      const path = join(root, "libtarget.so");
      const notes = Buffer.concat([
        androidIdentNote({
          androidApi: 24,
          ndkVersion: "r27c",
          ndkBuildNumber: "12297006",
          little: target.little,
        }),
        androidIdentNote({
          androidApi: 21,
          ndkVersion: null,
          ndkBuildNumber: null,
          little: target.little,
        }),
        elfNote("Android", 2, Buffer.from([0xde, 0xad]), target.little),
        gnuBuildIdNote(undefined, target.little),
      ]);
      await writeFile(
        path,
        elfNoteFixture({
          bits: target.bits,
          little: target.little,
          machine: target.machine,
          ownership: "section",
          sectionName: ".note.android.ident",
          notes,
        }),
      );

      const cliOut = await cli.sharedCliRun!({
        arguments: ["inspect-elf-notes", path, "--json"],
      });
      expect(cliOut.exitCode, cliOut.stderr).toBe(0);
      const call = await cli.sharedMcpCall!();
      const mcpOut = await call("inspect_elf_notes", { path });
      expect(mcpOut.isError, JSON.stringify(mcpOut.content)).not.toBe(true);

      const schema = inspectElfNotesContract.outputSchema;
      const cliReport = schema.parse(cliOut.json).normalized_result;
      const mcpReport = schema.parse(
        mcpOut.structuredContent,
      ).normalized_result;
      expect(cliReport).toEqual(mcpReport);
      expect(cliReport.byte_order).toBe(target.little ? "little" : "big");
      expect(cliReport.entries.map((entry) => entry.type_name)).toEqual([
        "android_ident",
        "android_ident",
        "unknown",
        "gnu_build_id",
      ]);
      expect(cliReport.entries[0]?.android).toEqual({
        android_api: 24,
        ndk_version: "r27c",
        ndk_build_number: "12297006",
      });
      expect(cliReport.entries[1]?.android).toEqual({
        android_api: 21,
        ndk_version: null,
        ndk_build_number: null,
      });
      expect(cliReport.entries[2]?.android).toBeNull();
      expect(cliReport.entries[3]?.android).toBeNull();
    },
  );
