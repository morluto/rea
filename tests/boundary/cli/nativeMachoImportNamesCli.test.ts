import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const run = promisify(execFile);

describe.skipIf(process.platform !== "darwin")(
  "native Mach-O CLI chained import names",
  () => {
    cliTest(
      "names a weak-def-coalesce import that the undefined symbol table omits",
      async ({ cli }) => {
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
        await run("/usr/bin/xcrun", [
          "clang++",
          "-arch",
          "arm64",
          "-dynamiclib",
          source,
          "-o",
          library,
        ]);
        const { stdout } = await run("/usr/bin/xcrun", [
          "dyld_info",
          "-imports",
          library,
        ]);
        expect(stdout).toMatch(/__Z3inli {2}\(from <weak-def-coalesce>\)/u);
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
  },
);
