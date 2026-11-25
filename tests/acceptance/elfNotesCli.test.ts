import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  compressedElfNoteFixture,
  compressedElfNoteSectionFixture,
  elfExtendedSectionCountFixture,
  elfNote,
  elfNoteFixture,
  elfNoteWithUnreadableSectionNameFixture,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest("reports a GNU build-id through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-notes-cli-");
  const path = join(root, "program");
  await writeFile(path, elfNoteFixture({ ownership: "program" }));
  const result = await cli.run({
    arguments: ["inspect-elf-notes", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
    result.json,
  );
  expect(
    evidence.normalized_result.entries.find(
      (entry) => entry.type_name === "gnu_build_id",
    )?.gnu?.build_id_hex,
  ).toBe("0123456789abcdef0123456789abcdef01234567");
});

cliTest(
  "reports FDO producer assertions in public ELF note Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-fdo-cli-");
    const path = join(root, "program");
    const metadata = [{ soname: ["libdemo.so.1"], feature: "examples" }];
    const notes = elfNote(
      "FDO",
      0x407c0c0a,
      Buffer.from(JSON.stringify(metadata) + "\0"),
    );
    await writeFile(
      path,
      elfNoteFixture({
        ownership: "section",
        notes,
        sectionName: ".note.dlopen",
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.entries[0]).toMatchObject({
      type_name: "fdo_dlopen_metadata",
      fdo: { metadata, issue: null },
    });
    expect(evidence.limitations).toContain(
      "FDO packaging and dlopen metadata are unverified producer declarations.",
    );
  },
);

cliTest(
  "resolves section note names from a compressed string table through the CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-compressed-cli-");
    const path = join(root, "compressed-names.elf");
    const bytes = compressedElfNoteFixture(64, true, 2);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.tables[0]?.name).toBe(
      ".note.gnu.build-id",
    );
    expect(evidence.normalized_result.entries[0]?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  },
);

cliTest(
  "keeps GNU notes when a section-name offset is outside its string table",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-name-cli-");
    const path = join(root, "program");
    const bytes = elfNoteWithUnreadableSectionNameFixture("outside");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.tables[0]?.name).toBeNull();
    expect(evidence.normalized_result.limitations.join(" ")).toMatch(
      /name offset.*string table/iu,
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

cliTest(
  "resolves a relative ELF path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-cli-rel-");
    await writeFile(
      join(root, "unsigned"),
      elfNoteFixture({ ownership: "none" }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-notes", "unsigned", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.tables).toEqual([]);
    expect(evidence.subject?.local_path).toBe(join(root, "unsigned"));
  },
);

cliTest(
  "reports compressed note storage as unsupported without mutation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-storage-cli-");
    const path = join(root, "aliased.o");
    const bytes = compressedElfNoteSectionFixture(64, true, "both");
    // The program starts inside the compressed section and ends beyond it.
    bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64 + 8) + 4n, 64 + 8);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      message: expect.stringMatching(/compressed.*note/iu),
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  },
);

cliTest(
  "reports valid extended numbering as unsupported without mutation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-extended-cli-");
    const path = join(root, "extended-count.elf");
    await writeFile(path, elfExtendedSectionCountFixture());
    const before = await readFile(path);
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      message: expect.stringMatching(/extended.*number/iu),
    });
    expect((await readFile(path)).equals(before)).toBe(true);
  },
);

cliTest(
  "rejects dangling section-name references and preserves sectionless notes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-presence-cli-");
    const path = join(root, "program");
    for (const ownership of ["program", "none"] as const) {
      const bytes = elfNoteFixture({ ownership });
      bytes.writeUInt16LE(5, 62);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-elf-notes", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
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
      const accepted = await cli.run({
        arguments: ["inspect-elf-notes", path, "--json"],
      });
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
        accepted.json,
      );
      expect(evidence.normalized_result.coverage.status).toBe("complete");
      expect(evidence.normalized_result.tables).toHaveLength(
        ownership === "none" ? 0 : 1,
      );
    }
  },
);
