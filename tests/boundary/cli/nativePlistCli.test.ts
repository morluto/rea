import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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

    cliTest.for(["xml", "binary"] as const)(
      "decodes $0 plists that plutil cannot express as JSON",
      async (format, { cli }) => {
        const directory = await createTestTempDirectory("rea-plist-types-");
        const app = join(directory, "Example.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(
          join(contents, "MacOS/App"),
          thinMach(0xfeedfacf, 0x0100000c),
        );
        const plist = join(contents, "Info.plist");
        await writeFile(
          plist,
          [
            "<plist><dict>",
            "<key>CFBundleExecutable</key><string>App</string>",
            "<key>CFBundleIdentifier</key><string>com.example.types</string>",
            "<key>Blob</key><data>AAEC</data>",
            "<key>Built</key><date>2020-01-01T00:00:00Z</date>",
            "<key>Ratio</key><real>nan</real>",
            "</dict></plist>",
          ].join(""),
        );
        if (format === "binary")
          await promisify(execFile)("/usr/bin/plutil", [
            "-convert",
            "binary1",
            "--",
            plist,
          ]);
        const result = await cli.run({
          arguments: ["inspect-plist", app, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            format,
            value: {
              CFBundleIdentifier: "com.example.types",
              Blob: { $plist_type: "data", base64: "AAEC" },
              Built: {
                $plist_type: "date",
                iso8601: "2020-01-01T00:00:00.000Z",
              },
              Ratio: { $plist_type: "real", value: null },
            },
            bundle: { identifier: "com.example.types", executable: "App" },
            provenance: [
              { tool: "file" },
              { command: expect.arrayContaining(["json"]), exit: { code: 1 } },
              { command: expect.arrayContaining(["xml1"]), exit: { code: 0 } },
            ],
            limitations: [
              expect.stringContaining("XML conversion"),
              expect.stringContaining("1 non-finite real"),
            ],
          },
        });
      },
    );
  },
);

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI integers",
  () => {
    cliTest.for([false, true])(
      "reports exact plist integers and integral reals beyond the JSON number range (data: %s)",
      async (withData, { cli }) => {
        const directory = await createTestTempDirectory("rea-plist-integers-");
        const app = join(directory, "Example.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(
          join(contents, "MacOS/App"),
          thinMach(0xfeedfacf, 0x0100000c),
        );
        await writeFile(
          join(contents, "Info.plist"),
          [
            "<plist><dict>",
            "<key>CFBundleExecutable</key><string>App</string>",
            "<key>Max</key><integer>18446744073709551615</integer>",
            "<key>Min</key><integer>-9223372036854775808</integer>",
            "<key>Count</key><integer>42</integer>",
            "<key>Real</key><real>9007199254740992</real>",
            "<key>Large</key><real>1e20</real>",
            ...(withData ? ["<key>Blob</key><data>AAEC</data>"] : []),
            "</dict></plist>",
          ].join(""),
        );
        const result = await cli.run({
          arguments: ["inspect-plist", app, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            value: {
              Max: { $plist_type: "integer", decimal: "18446744073709551615" },
              Min: { $plist_type: "integer", decimal: "-9223372036854775808" },
              Count: 42,
              Real: 9007199254740992,
              Large: 1e20,
            },
            limitations: [
              ...(withData ? [expect.stringContaining("XML conversion")] : []),
              expect.stringContaining("2 integer value(s)"),
            ],
          },
        });
      },
    );
  },
);
