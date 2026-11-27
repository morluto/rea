import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform !== "darwin")(
  "native Mach-O CLI chained import names",
  () => {
    cliTest(
      "names a weak-def-coalesce import that the undefined symbol table omits",
      async ({ cli, processes }) => {
        const directory = await createTestTempDirectory("rea-macho-imports-");
        const source = join(directory, "coalesce.cpp");
        // Taking an exported inline function's address makes the linker bind
        // it through <weak-def-coalesce>, as a defined weak symbol.
        await writeFile(
          source,
          [
            'inline __attribute__((visibility("default"))) int inl(int x) { return x * 3; }',
            '__attribute__((visibility("default"))) int (*getinl())(int) { return &inl; }',
            "",
          ].join("\n"),
        );
        const library = join(directory, "libcoalesce.dylib");
        const compiled = await processes.run("/usr/bin/xcrun", [
          "clang++",
          "-arch",
          "arm64",
          "-dynamiclib",
          source,
          "-o",
          library,
        ]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const imports = await processes.run("/usr/bin/xcrun", [
          "dyld_info",
          "-imports",
          library,
        ]);
        expect(imports.exitCode, imports.stderr).toBe(0);
        expect(imports.stdout).toMatch(
          /__Z3inli {2}\(from <weak-def-coalesce>\)/u,
        );
        const result = await cli.run({
          arguments: ["inspect-macho", library, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(result.exitCode, result.stdout).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            imports: {
              items: [
                {
                  name: "__Z3inli",
                  name_status: "exact",
                  source: "<weak-def-coalesce>",
                },
              ],
            },
          },
        });
      },
      60_000,
    );
    cliTest(
      "names an arm64e typeinfo import whose bind addend dyld_info appends",
      async ({ cli, processes }) => {
        const directory = await createTestTempDirectory("rea-macho-addend-");
        const source = join(directory, "shape.cpp");
        // A polymorphic class's typeinfo binds 16 bytes into the libc++
        // class_type_info vtable; arm64e records that in the import table.
        await writeFile(
          source,
          [
            'struct __attribute__((visibility("default"))) Shape { virtual ~Shape(); };',
            "Shape::~Shape() {}",
            "",
          ].join("\n"),
        );
        const library = join(directory, "libshape.dylib");
        const compiled = await processes.run("/usr/bin/xcrun", [
          "clang++",
          "-arch",
          "arm64e",
          "-dynamiclib",
          source,
          "-o",
          library,
        ]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const imports = await processes.run("/usr/bin/xcrun", [
          "dyld_info",
          "-imports",
          library,
        ]);
        expect(imports.exitCode, imports.stderr).toBe(0);
        expect(imports.stdout).toContain(
          "  __ZTVN10__cxxabiv117__class_type_infoE+0x10  (from libc++)",
        );
        const result = await cli.run({
          arguments: ["inspect-macho", library, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(result.exitCode, result.stdout).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            imports: {
              items: expect.arrayContaining([
                {
                  name: "__ZTVN10__cxxabiv117__class_type_infoE",
                  runtime_name: "_ZTVN10__cxxabiv117__class_type_infoE",
                  raw_name: null,
                  name_status: "exact",
                  addend: "0x10",
                  address: null,
                  weak: null,
                  reexport: null,
                  source: "libc++",
                },
              ]),
            },
          },
        });
      },
      60_000,
    );
  },
);
