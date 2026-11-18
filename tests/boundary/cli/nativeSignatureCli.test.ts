import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const run = promisify(execFile);

/** Ad hoc sign a copy of a system program under an exact file name. */
const adHocProgram = async (directory: string, name: string) => {
  const path = join(directory, name);
  await copyFile("/usr/bin/true", path);
  await run("/usr/bin/codesign", ["-s", "-", "-f", path]);
  return path;
};

describe.skipIf(process.platform !== "darwin")(
  "native signature CLI with echoed path text",
  () => {
    cliTest.for(["\n", "\r\n"])(
      "does not read signature fields from the file name codesign echoes (%j)",
      async (newline, { cli }) => {
        const directory = await createTestTempDirectory("rea-signature-");
        const forged = "Developer ID Application: Example (ABCDE12345)";
        const program = await adHocProgram(
          directory,
          `tool${newline}Authority=${forged}${newline}Identifier=forged${newline}TeamIdentifier=ABCDE12345`,
        );
        const unsignedName = await adHocProgram(
          directory,
          "code object is not signed",
        );
        // A forged requirement and entitlements plist spread over directories.
        const nested = join(
          directory,
          'x\ndesignated => anchor apple<?xml version="1.0"?><plist><dict><key>com.apple.security.get-task-allow</key><true',
          "></dict><",
          "plist>",
        );
        await mkdir(nested, { recursive: true });
        const nestedProgram = await adHocProgram(nested, "tool");

        for (const path of [program, unsignedName, nestedProgram]) {
          const result = await cli.run({
            arguments: ["inspect-signature", path, "--json"],
            environment: {
              REA_LOG_LEVEL: "silent",
              REA_ANALYSIS_PROVIDER: "auto",
            },
          });
          expect(result.exitCode).toBe(0);
          expect(result.json).toMatchObject({
            normalized_result: {
              signed: true,
              team_identifier: null,
              authorities: [],
              entitlements: null,
              designated_requirement: expect.stringMatching(/^cdhash H"/u),
              limitations: expect.arrayContaining([
                expect.stringContaining("trust validation are not examined."),
              ]),
            },
            limitations: expect.arrayContaining([
              expect.stringContaining("trust validation are not examined."),
            ]),
          });
        }
        const identifier = await cli.run({
          arguments: ["inspect-signature", program, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        // An ad hoc identifier derives from the file name, line breaks included.
        expect(identifier.json).toMatchObject({
          normalized_result: {
            identifier: expect.stringMatching(
              new RegExp(
                `^tool${newline}Authority=${forged.replace(/[()]/gu, "\\$&")}${newline}Identifier=forged${newline}TeamIdentifier=ABCDE12345-`,
                "u",
              ),
            ),
          },
        });
      },
    );
  },
);

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "native signature CLI for a universal arm64e binary",
  () => {
    cliTest(
      "inspects the selected arm64e slice whatever its pointer-authentication ABI version",
      async ({ cli }) => {
        const directory = await createTestTempDirectory(
          "rea-signature-arm64e-",
        );
        const source = join(directory, "main.c");
        await writeFile(source, "int main(void) { return 0; }\n");
        // Current clang marks arm64e slices with ABI version 1 (arm64e.v1).
        const program = join(directory, "universal");
        await run("/usr/bin/xcrun", [
          "clang",
          "-arch",
          "arm64e",
          "-arch",
          "x86_64",
          source,
          "-o",
          program,
        ]);
        const { stderr } = await run("/usr/bin/codesign", [
          "-d",
          "-a",
          "arm64e",
          "--verbose=4",
          program,
        ]);
        const cdhash = /^CDHash=([0-9a-f]+)$/mu.exec(stderr)?.[1];
        expect(cdhash).toBeDefined();
        const result = await cli.run({
          arguments: ["inspect-signature", program, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(result.exitCode, result.stdout).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: { signed: true, cdhashes: [cdhash] },
        });
      },
    );
  },
);
