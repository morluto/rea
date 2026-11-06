import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../../support/cli/cliFixture.js";

cliTest(
  "identifies the missing companion option for firmware range input",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-firmware-incomplete-range-",
    );
    const firmware = join(root, "firmware.bin");
    await writeFile(firmware, new Uint8Array());
    const output = join(root, "extracted");
    const cases = [
      { option: "--offset", missing: "length" },
      { option: "--length", missing: "offset" },
    ] as const;

    for (const { option, missing } of cases) {
      const result = await cli.run({
        arguments: [
          "extract-firmware",
          firmware,
          output,
          option,
          "5",
          "--json",
        ],
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(analysisErrorProjectionSchema.safeParse(result.json).success).toBe(
        true,
      );
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        details: {
          operation: "extract_firmware",
          issues: [
            {
              path: ["range", missing],
              reason: "missing_argument",
            },
          ],
        },
      });
    }
  },
);

// Each spelling is one that numeric coercion admits within the field's
// bounds: "" becomes 0, "0x10" becomes 16 and "1e3" becomes 1000.
cliTest.for([
  ["extract-firmware", ["--offset=", "--length=5"], "offset"],
  ["extract-firmware", ["--offset=0", "--length=0x10"], "length"],
  ["extract-firmware", ["--max-depth=0x2"], "maxDepth"],
  ["extract-firmware", ["--max-output-bytes=1e3"], "maxOutputBytes"],
  ["extract-firmware", ["--max-output-files=0x10"], "maxOutputFiles"],
  [
    "extract-firmware",
    ["--publication-timeout-ms=1e3"],
    "publicationTimeoutMs",
  ],
  ["extract-firmware", ["--analysis-timeout-ms=0x10"], "analysisTimeoutMs"],
  [
    "inspect-firmware-regions",
    ["--analysis-timeout-ms=1e3"],
    "analysisTimeoutMs",
  ],
] as const)("rejects %s %j", async ([command, flags, field], { cli }) => {
  const root = await createTestTempDirectory("rea-firmware-decimal-");
  const firmware = join(root, "firmware.bin");
  const output = command === "extract-firmware" ? [join(root, "out")] : [];
  const result = await runFileCli(cli, {
    arguments: [command, firmware, ...output, ...flags, "--json"],
  });

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [expect.objectContaining({ path: field })],
  });
});
