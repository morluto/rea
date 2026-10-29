import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type CliResult } from "../../support/cli/cliFixture.js";

// Numeric coercion reads each of these as 16 (or 10 for "1e1").
const NON_DECIMAL_TEXT = ["0x10", "0b10000", "1e1", "+16", "16.0", " 16"];

const nativeUi = (...flags: string[]): string[] => [
  "observe-native-ui",
  "Demo.app",
  "--pid=16",
  "--window-id=7",
  ...flags,
];

/** A present plist, so only option parsing can refuse at validation. */
const plist = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-utility-options-");
  const path = join(root, "Info.plist");
  await writeFile(
    path,
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n',
  );
  return path;
};

const expectFieldRefusal = (result: CliResult, field: string): void => {
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: expect.arrayContaining([
      expect.objectContaining({ path: field }),
    ]),
  });
};

const expectPastValidation = (result: CliResult): void => {
  expect(JSON.parse(result.stdout)).not.toMatchObject({
    code: "VALIDATION_ERROR",
  });
};

describe("utility command integer options", () => {
  for (const [flag, field] of [
    ["--pid", "pid"],
    ["--window-id", "windowId"],
    ["--max-nodes", "maxNodes"],
    ["--native-ui-deadline-ms", "nativeUiDeadlineMs"],
  ] as const) {
    cliTest.for(NON_DECIMAL_TEXT)(
      `rejects %j as a native UI ${flag} value`,
      async (value, { cli }) => {
        // A later flag replaces the decimal --pid/--window-id defaults.
        const result = await cli.run({
          arguments: [...nativeUi(`${flag}=${value}`), "--json"],
        });

        expectFieldRefusal(result, field);
      },
    );
  }

  cliTest.for(NON_DECIMAL_TEXT)(
    "rejects %j as a native command timeout",
    async (value, { cli }) => {
      const result = await cli.run({
        arguments: [
          "inspect-plist",
          await plist(),
          `--native-command-timeout-ms=${value}`,
          "--json",
        ],
      });

      expectFieldRefusal(result, "nativeCommandTimeoutMs");
    },
  );

  cliTest(
    "keeps the native deadline bounds for decimal text",
    async ({ cli }) => {
      for (const value of ["0", "2147483648"]) {
        const result = await cli.run({
          arguments: [
            ...nativeUi(`--native-ui-deadline-ms=${value}`),
            "--json",
          ],
        });
        expectFieldRefusal(result, "nativeUiDeadlineMs");
      }
      expectFieldRefusal(
        await cli.run({ arguments: [...nativeUi("--pid=0"), "--json"] }),
        "pid",
      );
    },
  );

  cliTest("admits decimal utility integer options", async ({ cli }) => {
    expectPastValidation(
      await cli.run({
        arguments: [
          ...nativeUi("--max-nodes=500", "--native-ui-deadline-ms=2147483647"),
          "--json",
        ],
      }),
    );
    expectPastValidation(
      await cli.run({
        arguments: [
          "inspect-plist",
          await plist(),
          "--native-command-timeout-ms=1000",
          "--json",
        ],
      }),
    );
  });
});
