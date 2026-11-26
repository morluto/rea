import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  androidIdentNote,
  elfExtendedSectionCountFixture,
  compressedElfNoteSectionFixture,
  elfNote,
  elfNoteFixture,
  elfNoteWithUnreadableSectionNameFixture,
} from "../../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

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

fileInspectionTest(
  "advertises inspect_elf_notes and reads a GNU build-id",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_elf_notes",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-elf-notes-mcp-");
    const path = join(root, "program");
    await writeFile(path, elfNoteFixture({ bits: 32, ownership: "section" }));
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = inspectElfNotesContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.format).toBe("elf32");
    expect(
      evidence.normalized_result.entries.find(
        (entry) => entry.type_name === "gnu_build_id",
      )?.gnu?.build_id_hex,
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  },
);

fileInspectionTest(
  "keeps GNU notes when a section name is not NUL-terminated",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-notes-name-mcp-");
    const path = join(root, "program");
    const bytes = elfNoteWithUnreadableSectionNameFixture("unterminated");
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = inspectElfNotesContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.tables[0]?.name).toBeNull();
    expect(evidence.normalized_result.limitations.join(" ")).toMatch(
      /name.*not NUL.terminated/iu,
    );
    expect(evidence.normalized_result.entries[0]?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(evidence.normalized_result.coverage).toMatchObject({
      status: "complete",
      examined_tables: 1,
      examined_entries: 1,
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  },
);

fileInspectionTest(
  "reports compressed note storage as unsupported without mutation",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-notes-storage-mcp-");
    const path = join(root, "debug-notes.o");
    const bytes = compressedElfNoteSectionFixture();
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      message: expect.stringMatching(/compressed.*note/iu),
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  },
);

fileInspectionTest(
  "reports valid extended numbering as unsupported without mutation",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-notes-extended-mcp-");
    const path = join(root, "extended-count.elf");
    await writeFile(path, elfExtendedSectionCountFixture());
    const before = await readFile(path);
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      message: expect.stringMatching(/extended.*number/iu),
    });
    expect((await readFile(path)).equals(before)).toBe(true);
  },
);

fileInspectionTest(
  "rejects dangling section-name references and recovers in the same session",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-notes-presence-mcp-");
    const path = join(root, "program");
    const bytes = elfNoteFixture({ ownership: "program" });
    bytes.writeUInt16LE(5, 62);
    await writeFile(path, bytes);
    const rejected = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(rejected.isError).toBe(true);
    expect(parseMcpToolError(rejected).error).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      details: {
        operation: "inspect_elf_notes",
        path,
        failure_kind: "malformed",
        format: "elf",
      },
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
    bytes.writeUInt16LE(0, 62);
    await writeFile(path, bytes);
    const accepted = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(accepted.isError).not.toBe(true);
    const evidence = inspectElfNotesContract.outputSchema.parse(
      accepted.structuredContent,
    );
    expect(evidence.normalized_result.entries[0]?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  },
);

fileInspectionTest(
  "decodes Android .note.android.ident and preserves truncated descriptors over MCP",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-android-mcp-");
    const path = join(root, "libnative.so");
    await writeFile(
      path,
      elfNoteFixture({
        bits: 64,
        machine: 183,
        ownership: "section",
        sectionName: ".note.android.ident",
        notes: Buffer.concat([
          androidIdentNote({
            androidApi: 24,
            ndkVersion: "r27c",
            ndkBuildNumber: "12297006",
          }),
          elfNote("Android", 1, Buffer.from([0x18, 0x00])),
        ]),
      }),
    );
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = inspectElfNotesContract.outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.entries[0]?.android).toEqual({
      android_api: 24,
      ndk_version: "r27c",
      ndk_build_number: "12297006",
    });
    expect(evidence.normalized_result.entries[1]).toMatchObject({
      type_name: "android_ident",
      android: null,
      descriptor: { hex: "1800" },
    });
  },
);
