import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { elfDependencyFixture } from "../../src/native/elf/ElfDependencies.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const dependenciesContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_elf_dependencies",
);

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
    const evidence = dependenciesContract.outputSchema.parse(result.json);
    expect(evidence.parameters).toEqual({ path });
    const selected = await cli.run({
      arguments: [
        "inspect-elf-dependencies",
        path,
        "--max-needed",
        "1024",
        "--json",
      ],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    const explicitlySelected = dependenciesContract.outputSchema.parse(
      selected.json,
    );
    expect(explicitlySelected.parameters).toEqual({ path, max_needed: 1024 });
    expect(explicitlySelected.evidence_id).not.toBe(evidence.evidence_id);
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
  "distinguishes the ELF string scan cap from an observed unterminated table end",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-string-end-",
    );
    for (const { kind, length, truncate, message } of [
      {
        kind: "unterminated-at-cap",
        length: 65536,
        truncate: true,
        message: "DT_SONAME string is unterminated in the dynamic string table",
      },
      {
        kind: "terminator-beyond-cap",
        length: 65536,
        truncate: false,
        message:
          "DT_SONAME string has no terminator within the 65536-byte string scan limit in the dynamic string table",
      },
      {
        kind: "terminator-at-cap",
        length: 65535,
        truncate: false,
        message: null,
      },
    ]) {
      const path = join(root, kind);
      // Place SONAME last, with a nonzero string-table index and no neighboring
      // string that could supply a terminator after the selected bytes.
      await writeFile(
        path,
        elfDependencyFixture({
          soname: "s".repeat(length),
          runpath: null,
          imports: [],
          verneed: [],
          verdef: [],
          truncateDynstr: truncate,
        }),
      );
      const result = await cli.run({
        arguments: ["inspect-elf-dependencies", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = dependenciesContract.outputSchema.parse(
        result.json,
      ).normalized_result;
      if (!("dynamic" in report))
        throw new Error("Expected an inline ELF dependency inventory");
      expect(
        report.needed.map(({ name }) => name),
        kind,
      ).toEqual(["libstdc++.so.6", "libm.so.6", "libc.so.6"]);
      const issue = report.issues.find(
        ({ location }) => location === "DT_SONAME",
      );
      if (message === null) {
        expect(issue, kind).toBeUndefined();
        expect(report.dynamic.soname?.name?.length, kind).toBe(length);
        expect(report.coverage.status, kind).toBe("complete");
      } else {
        expect(issue, kind).toMatchObject({ code: "name_unreadable", message });
        expect(report.dynamic.soname?.name, kind).toBeNull();
        expect(report.coverage.status, kind).toBe("partial");
      }
    }
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
    const evidence = dependenciesContract.outputSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      dynamic: { status: "absent" },
      needed: [],
      coverage: { status: "complete" },
    });
    expect(evidence.subject?.local_path).toBe(join(root, "program"));
    expect(evidence.caller_input_path).toBe("program");
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

for (const tableAvailable of [true, false]) {
  cliTest(
    `keeps DT_NEEDED diagnostics at known file bytes (string table available: ${tableAvailable})`,
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-elf-dependencies-name-location-",
      );
      const path = join(root, "program");
      const badOffset = 0x10000;
      const image = elfDependencyFixture({
        bits: 64,
        little: true,
        stripped: true,
        wideNameOffset: badOffset,
        needed: ["outside", "", "libc.so.6"],
      });
      // This fixture writes PT_DYNAMIC as the last header and the needed
      // records first. Read their file positions independently of the report.
      const lastHeader =
        Number(image.readBigUInt64LE(32)) +
        (image.readUInt16LE(56) - 1) * image.readUInt16LE(54);
      const dynamicOffset = Number(image.readBigUInt64LE(lastHeader + 8));
      let tableEntry = dynamicOffset;
      while (image.readBigInt64LE(tableEntry) !== 5n) tableEntry += 16;
      const tableOffset = Number(image.readBigUInt64LE(tableEntry + 8));
      if (!tableAvailable)
        image.writeBigUInt64LE(BigInt(image.length + 16), tableEntry + 8);
      await writeFile(path, image);

      const result = await cli.run({
        arguments: ["inspect-elf-dependencies", path, "--json"],
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const report = dependenciesContract.outputSchema.parse(
        result.json,
      ).normalized_result;
      if (!("needed" in report))
        throw new Error("Expected an inline ELF dependency inventory");
      expect(report.coverage.status).toBe("partial");
      expect(report.needed).toMatchObject([
        { name: null, name_offset: badOffset },
        { name: null, name_offset: 0 },
        { name: tableAvailable ? "libc.so.6" : null },
      ]);
      const diagnostics = report.issues.filter(
        ({ code, message }) =>
          code === "name_unreadable" && message.startsWith("DT_NEEDED "),
      );
      expect(diagnostics[0]).toMatchObject({
        location: `0x${dynamicOffset.toString(16)}`,
        message: tableAvailable
          ? "DT_NEEDED string offset 65536 is outside the dynamic string table"
          : "DT_NEEDED string offset 65536 could not be read because the dynamic string table is unavailable",
      });
      expect(diagnostics[1]?.location).toBe(
        `0x${(tableAvailable ? tableOffset : dynamicOffset + 16).toString(16)}`,
      );
      if (tableAvailable) {
        expect(report.issues).toContainEqual({
          code: "name_unreadable",
          location: "DT_SONAME",
          message:
            "DT_SONAME string offset is outside the dynamic string table",
        });
        expect(report.dynamic.runpath?.raw).toBe("$ORIGIN/../lib");
      } else {
        for (const location of [
          "DT_SONAME",
          "DT_RUNPATH",
          "vn_file",
          "vna_name",
          "vda_name",
          "dynsym[1]",
        ]) {
          expect(report.issues, location).toContainEqual(
            expect.objectContaining({
              code: "name_unreadable",
              location,
              message: expect.stringContaining(
                "dynamic string table is unavailable",
              ),
            }),
          );
        }
      }
    },
  );
}
