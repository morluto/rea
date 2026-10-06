import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI selection",
  () => {
    cliTest.for([
      ["default", undefined, "default"],
      ["alternate", "Contents/Alternate.plist", "alternate"],
      ["missing", "Contents/Missing.plist", undefined],
    ] as const)(
      "honors the $0 plist selection",
      async ([, selected, identifier], { cli }) => {
        const directory = await createTestTempDirectory("rea-plist-cli-");
        const app = join(directory, "Example.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(
          join(contents, "MacOS/App"),
          thinMach(0xfeedfacf, 0x0100000c),
        );
        for (const [name, value] of [
          ["Info", "default"],
          ["Alternate", "alternate"],
        ]) {
          await writeFile(
            join(contents, `${name}.plist`),
            `<plist><dict><key>CFBundleExecutable</key><string>App</string><key>CFBundleIdentifier</key><string>${value}</string></dict></plist>`,
          );
        }
        const result = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            ...(selected === undefined ? [] : ["--relative-path", selected]),
            "--json",
          ],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        if (identifier === undefined) {
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({ error: "Analysis failed" });
        } else {
          expect(result.exitCode).toBe(0);
          expect(result.json).toMatchObject({
            normalized_result: {
              source_path: join(app, selected ?? "Contents/Info.plist"),
              value: { CFBundleIdentifier: identifier },
            },
          });
        }
      },
    );
  },
);
