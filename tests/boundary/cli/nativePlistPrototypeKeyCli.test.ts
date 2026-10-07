import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const OMITTED =
  "1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.";

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI with a __proto__ key",
  () => {
    cliTest.for([
      ["JSON-expressible", ""],
      ["data-bearing", "<key>Blob</key><data>AAEC</data>"],
    ] as const)(
      "inspects a $0 plist and reports the omitted key",
      async ([, extra], { cli }) => {
        const directory = await createTestTempDirectory("rea-plist-proto-");
        const app = join(directory, "Proto.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(
          join(contents, "MacOS/App"),
          thinMach(0xfeedfacf, 0x100000c),
        );
        await writeFile(
          join(contents, "Info.plist"),
          `<plist><dict><key>CFBundleExecutable</key><string>App</string><key>__proto__</key><dict><key>polluted</key><true/></dict>${extra}</dict></plist>`,
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
            value: { CFBundleExecutable: "App" },
            bundle: { executable: "App" },
            limitations: expect.arrayContaining([OMITTED]),
          },
        });
        expect(JSON.stringify(result.json)).not.toContain("polluted");
      },
    );
  },
);
