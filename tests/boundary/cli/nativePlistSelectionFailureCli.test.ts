import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

/** An app bundle whose Contents holds a directory and a non-plist file. */
const fixtureApp = async () => {
  const app = join(await createTestTempDirectory("rea-plist-fail-"), "A.app");
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Folder.plist"));
  await writeFile(join(contents, "MacOS/App"), thinMach(0xfeedfacf, 0x100000c));
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  await writeFile(join(contents, "Text.plist"), "not a property list\n");
  return app;
};

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI selection failures",
  () => {
    cliTest.for([
      ["Contents/Missing.plist", "no file exists there."],
      ["Contents/Folder.plist", "it is not a regular file."],
      ["Contents/Text.plist", "plutil could not decode it as a property list"],
    ] as const)(
      "reports why the selected %s cannot be inspected",
      async ([selected, reason], { cli }) => {
        const app = await fixtureApp();
        const result = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            "--relative-path",
            selected,
            "--json",
          ],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          details: {
            operation: "inspect_plist",
            issues: [
              {
                path: ["path"],
                reason: "invalid_value",
                message: expect.stringContaining(
                  `Cannot inspect ${join(app, selected)}: ${reason}`,
                ),
              },
            ],
          },
        });
      },
    );

    // Root bypasses file modes, so the denial is only observable otherwise.
    cliTest.skipIf(process.getuid?.() === 0)(
      "reports a permission denial instead of a malformed plist",
      async ({ cli, onTestFinished }) => {
        const app = await fixtureApp();
        const locked = join(app, "Contents/Locked.plist");
        await writeFile(locked, "<plist><dict/></plist>");
        await chmod(locked, 0o000);
        onTestFinished(async () => {
          await chmod(locked, 0o600);
        });
        const result = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            "--relative-path",
            "Contents/Locked.plist",
            "--json",
          ],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "target_unavailable",
          details: {
            path: locked,
            reason: "permission denied while reading plist (EACCES)",
          },
        });
      },
    );

    cliTest(
      "reports a missing default Info.plist as unavailable for the target",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-plist-bare-");
        const program = join(directory, "tool");
        await writeFile(program, thinMach(0xfeedfacf, 0x100000c));
        const result = await cli.run({
          arguments: ["inspect-plist", program, "--json"],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "capability_unavailable",
          details: {
            operation: "inspect_plist",
            reason: expect.stringContaining(
              `no readable Contents/Info.plist at ${join(directory, "Contents/Info.plist")}: no file exists there.`,
            ),
          },
        });
      },
    );
  },
);
