import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfRelocatableCtors,
  elf64AliasedInitializers,
  elfUnmappedInitializerTargets,
  machoArm64Initializers,
} from "../../src/native/initializers/NativeInitializers.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = toolContract("inspect_native_initializers");

cliTest(
  "keeps an unrelocated ELF alias's value and source identity through the CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-init-alias-cli-");
    const path = join(root, "program");
    const bytes = elf64AliasedInitializers();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-native-initializers", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = contract.outputSchema.parse(result.json).normalized_result;
    expect(report.status).toBe("parsed");
    expect(report.artifact).toMatchObject({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(
      report.entries.find((entry) => entry.kind === "preinit_array"),
    ).toMatchObject({
      slot_va: "0x200",
      slot_file_offset: 0x200,
      value_va: "0x100",
      resolution: "relative_addend",
    });
    expect(
      report.entries.find((entry) => entry.kind === "init_array"),
    ).toMatchObject({
      slot_va: "0x1200",
      slot_file_offset: 0x200,
      value_va: "0x0",
      symbol: null,
      resolution: "raw",
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "lists Mach-O initializers and finalizers through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-init-cli-");
    const path = join(root, "program");
    await writeFile(path, machoArm64Initializers());
    const result = await cli.run({
      arguments: ["inspect-native-initializers", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(
      evidence.normalized_result.entries.map((entry) => [
        entry.kind,
        entry.value_va,
        entry.symbol?.name,
      ]),
    ).toEqual([
      ["mod_init", "0x100001000", "_init"],
      ["init_offsets", "0x100001000", "_init"],
      ["mod_term", "0x100001100", "_term"],
    ]);
  },
);

cliTest(
  "pages relocatable-object constructors with decimal options",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-init-cli-page-");
    const path = join(root, "object.o");
    await writeFile(path, elfRelocatableCtors());
    const result = await cli.run({
      arguments: [
        "inspect-native-initializers",
        path,
        "--offset",
        "1",
        "--limit",
        "1",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.coverage).toMatchObject({
      // Every slot read counts, including the two omitted .ctors sentinels.
      examined_entries: 4,
      total_entries: 2,
      returned_entries: 1,
      offset: 1,
    });
    expect(evidence.normalized_result.entries[0]).toMatchObject({
      index: 1,
      kind: "ctors",
      symbol: { name: "ctor" },
      resolution: "symbol_addend",
    });
  },
);

cliTest("reports a truncated image as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-native-init-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("\x7fELF"));
  const result = await cli.run({
    arguments: ["inspect-native-initializers", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_native_initializers" },
  });
});

cliTest(
  "keeps unmapped ELF target locations null in public CLI Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-init-unmapped-cli-");
    const path = join(root, "program");
    await writeFile(path, elfUnmappedInitializerTargets());
    const result = await cli.run({
      arguments: ["inspect-native-initializers", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(
      evidence.normalized_result.entries.map((entry) => [
        entry.value_va,
        entry.value_file_offset,
      ]),
    ).toEqual([
      ["0x0", null],
      ["0x10", null],
      ["0x401000", 0x100],
    ]);
    expect(evidence.normalized_result.coverage).toMatchObject({
      examined_entries: 3,
      total_entries: 3,
    });
  },
);
