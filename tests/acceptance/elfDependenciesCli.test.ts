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
  "delivers the ELF string scan limit and the other needed libraries",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-string-cap-",
    );
    const path = join(root, "program");
    await writeFile(
      path,
      elfDependencyFixture({
        soname: "s".repeat(65536),
        runpath: null,
        imports: [],
        verneed: [],
        verdef: [],
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const { normalized_result: report } =
      dependenciesContract.outputSchema.parse(result.json);
    if (!("dynamic" in report))
      throw new Error("Expected an inline ELF dependency inventory");
    expect(report.needed.map(({ name }) => name)).toEqual([
      "libstdc++.so.6",
      "libm.so.6",
      "libc.so.6",
    ]);
    expect(report.dynamic.soname?.name).toBeNull();
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual({
      location: "DT_SONAME",
      code: "name_unreadable",
      message:
        "DT_SONAME string has no terminator within the 65536-byte string scan limit in the dynamic string table",
    });
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

cliTest(
  "retains backed leading GNU version slots without section headers",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-dependencies-versym-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfDependencyFixture({ stripped: true, versymZeroFillOffset: 7 }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const { normalized_result: report } =
      dependenciesContract.outputSchema.parse(result.json);
    if (!("imports" in report))
      throw new Error("Expected an inline ELF dependency inventory");
    expect(report.coverage.status).toBe("partial");
    expect(report.imports.map(({ name }) => name)).toEqual([
      "printf",
      "memcpy",
      "_ZSt4cout",
      "abort",
      "_exit",
    ]);
    expect(
      report.imports.slice(0, 2).map(({ version }) => version?.name),
    ).toEqual(["GLIBC_2.34", "GLIBC_2.2.5"]);
    expect(report.imports.slice(2).map(({ version }) => version)).toEqual([
      null,
      null,
      null,
    ]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "table_unavailable",
        message:
          "GNU versym table holds 3 of 6 dynamic symbol slots; later slots were not read",
      }),
    );
  },
);

cliTest(
  "reports short GNU version tables when the symbol table is unavailable",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-short-versym-",
    );
    const path = join(root, "program");
    await writeFile(
      path,
      elfDependencyFixture({
        stripped: true,
        omitSymtabTag: true,
        versymZeroFillOffset: 7,
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const report = dependenciesContract.outputSchema.parse(
      result.json,
    ).normalized_result;
    if (!("imports" in report))
      throw new Error("Expected an inline ELF dependency inventory");
    expect(report.coverage).toMatchObject({
      status: "partial",
      examined_imports: 0,
    });
    expect(report.imports).toEqual([]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "table_unavailable",
        message:
          "GNU versym table holds 3 of 6 dynamic symbol slots; later slots were not read",
      }),
    );
  },
);

cliTest(
  "recovers ELF imports via DT_GNU_HASH when SHT_GNU_HASH is truncated or extends past EOF",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-dependencies-gnuhash-");
    const truncatedPath = join(root, "gnuhash-truncated.so");
    await writeFile(
      truncatedPath,
      elfDependencyFixture({
        omitHash: true,
        gnuHash: true,
        gnuHashSection: true,
        oversizedSection: ".dynsym",
        sectionSizes: { ".gnu.hash": 16 },
      }),
    );
    const truncatedResult = await cli.run({
      arguments: ["inspect-elf-dependencies", truncatedPath, "--json"],
    });
    expect(truncatedResult.exitCode, JSON.stringify(truncatedResult.json)).toBe(
      0,
    );
    const truncated = dependenciesContract.outputSchema.parse(
      truncatedResult.json,
    ).normalized_result;
    if (!("imports" in truncated))
      throw new Error("Expected an inline ELF dependency inventory");
    expect(truncated.coverage.status).toBe("partial");
    expect(truncated.imports.map(({ name }) => name)).toEqual([
      "printf",
      "memcpy",
      "_ZSt4cout",
      "abort",
      "_exit",
    ]);

    const pastEofPath = join(root, "gnuhash-past-eof.so");
    await writeFile(
      pastEofPath,
      elfDependencyFixture({
        omitHash: true,
        gnuHash: true,
        gnuHashSection: true,
        oversizedSection: ".dynsym",
        sectionSizes: { ".gnu.hash": 100_000 },
      }),
    );
    const pastEofResult = await cli.run({
      arguments: ["inspect-elf-dependencies", pastEofPath, "--json"],
    });
    expect(pastEofResult.exitCode, JSON.stringify(pastEofResult.json)).toBe(0);
    const pastEof = dependenciesContract.outputSchema.parse(
      pastEofResult.json,
    ).normalized_result;
    if (!("imports" in pastEof))
      throw new Error("Expected an inline ELF dependency inventory");
    expect(pastEof.coverage.status).toBe("partial");
    expect(pastEof.imports.map(({ name }) => name)).toEqual([
      "printf",
      "memcpy",
      "_ZSt4cout",
      "abort",
      "_exit",
    ]);
    expect(pastEof.issues).toContainEqual(
      expect.objectContaining({
        code: "malformed_entry",
        message:
          ".gnu.hash section header declares bytes past the end of the file",
      }),
    );
  },
);
