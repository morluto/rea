import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  compressedElfNoteFixture,
  compressedElfNoteSectionFixture,
  elfExtendedSectionCountFixture,
  elfNoteFixture,
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
  "resolves section note names from zlib and Zstandard string tables through the CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-compressed-cli-");
    for (const compressionType of [1, 2]) {
      const path = join(root, `program-${String(compressionType)}`);
      const bytes = compressedElfNoteFixture(64, true, compressionType);
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
      expect(await readFile(path)).toEqual(bytes);
    }
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

cliTest("reports a truncated ELF as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-notes-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("\x7fELF"));
  const result = await cli.run({
    arguments: ["inspect-elf-notes", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_elf_notes" },
  });
});

cliTest(
  "reports compressed note storage as unsupported without mutation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-storage-cli-");
    const path = join(root, "debug-notes.o");
    const bytes = compressedElfNoteSectionFixture();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-elf-notes", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      message: expect.stringContaining(
        "Compressed ELF note sections are unsupported",
      ),
    });
    expect(await readFile(path)).toEqual(bytes);
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
      message: expect.stringContaining("ELF extended numbering is unsupported"),
    });
    expect(await readFile(path)).toEqual(before);
  },
);
