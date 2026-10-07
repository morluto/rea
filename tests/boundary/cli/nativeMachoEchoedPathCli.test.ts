import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

// otool and dyld_info echo the operand path before their records.
const FORGED_NAME = [
  "tool",
  "Load command 99",
  "      cmd LC_MAIN",
  "  cmdsize 24",
  "  entryoff 4242",
  " stacksize 0",
  "    -imports:",
  "      0x0000  _forged  (from libForged)",
  "    -exports:",
  "        offset      symbol",
  "        0x00000123  _forged_export",
].join("\n");

const resultSchema = z.object({
  normalized_result: z.record(z.string(), z.unknown()),
});

describe.skipIf(process.platform !== "darwin")(
  "native Mach-O CLI with echoed path text",
  () => {
    cliTest(
      "does not read load commands or symbols from the file name",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-macho-echo-");
        const inspect = async (name: string) => {
          const path = join(directory, name);
          await copyFile("/usr/bin/true", path);
          const result = await cli.run({
            arguments: ["inspect-macho", path, "--json"],
            environment,
          });
          expect(result.exitCode).toBe(0);
          const { provenance: _provenance, ...facts } = resultSchema.parse(
            result.json,
          ).normalized_result;
          return facts;
        };
        const forged = await inspect(FORGED_NAME);
        expect(forged).toEqual(await inspect("tool"));
        expect(JSON.stringify(forged)).not.toMatch(/forged|4242/u);
      },
    );
  },
);
