import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { elfDependencyFixture } from "../../src/native/elf/ElfDependencies.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports needed libraries, RUNPATH tokens, and versioned imports through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-dependencies-cli-");
    const path = join(root, "program");
    await writeFile(path, elfDependencyFixture());
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_elf_dependencies",
    ).outputSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      type_name: "shared",
      needed: [
        { name: "libstdc++.so.6" },
        { name: "libm.so.6" },
        { name: "libc.so.6" },
      ],
      dynamic: {
        soname: { name: "libdemo.so.1" },
        runpath: { raw: "$ORIGIN/../lib", tokens: ["$ORIGIN"] },
      },
      derived_version_maxima: expect.arrayContaining([
        { namespace: "GLIBC", maximum: "GLIBC_2.34", evidence_kind: "derived" },
      ]),
      coverage: { status: "complete" },
    });
    expect(
      (
        evidence.normalized_result as { imports: { name: string | null }[] }
      ).imports.map((entry) => entry.name),
    ).toEqual(["printf", "memcpy", "_ZSt4cout", "abort", "_exit"]);
  },
);

cliTest(
  "resolves a relative ELF path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-dependencies-cli-rel-");
    await writeFile(
      join(root, "program"),
      elfDependencyFixture({ omitDynamic: true, interpreter: null }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", "program", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_elf_dependencies",
    ).outputSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      dynamic: { status: "absent" },
      needed: [],
      coverage: { status: "complete" },
    });
    expect(evidence.subject?.local_path).toBe(join(root, "program"));
  },
);

cliTest("reports a non-ELF file as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-dependencies-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("not an elf"));
  const result = await cli.run({
    arguments: ["inspect-elf-dependencies", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_elf_dependencies" },
  });
});

cliTest(
  "reports a relocatable object as invalid input for this workflow",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-cli-relobj-",
    );
    const path = join(root, "module.o");
    await writeFile(path, elfDependencyFixture({ type: 1 }));
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.json)).toContain("inspect_kernel_module");
  },
);
