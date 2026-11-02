import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform !== "darwin")(
  "OpenStep bundle escapes",
  () => {
    cliTest(
      "resolves the same native program through CLI and MCP",
      async ({ cli, processes }) => {
        const root = await createTestTempDirectory("rea-openstep-native-");
        const app = join(root, "Fixture.app");
        const contents = join(app, "Contents");
        const executable = join(contents, "MacOS", "Main");
        const info = join(contents, "Info.plist");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        const compiled = await processes.run("/usr/bin/xcrun", [
          "clang",
          resolve("tests/conformance/interface-builder/fixture.c"),
          "-o",
          executable,
        ]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const original = await readFile(executable);
        const { call } = await connectLocalToolsMcp({ PATH: "/usr/bin:/bin" });
        for (const source of [
          '{ CFBundleExecutable = "Main"; }',
          String.raw`{ CFBundleExecutable = "M\U0061in"; }`,
          String.raw`{ CFBundleExecutable = "M\141in"; }`,
          String.raw`{ "CFBundle\U0045xecutable" = "Main"; }`,
        ]) {
          await writeFile(info, source);
          const listed = await cli.run({
            arguments: ["list-architectures", app, "--json"],
            environment: { REA_LOG_LEVEL: "silent" },
          });
          expect(listed.exitCode, listed.stdout + listed.stderr).toBe(0);
          expect(listed.json).toMatchObject({
            subject: { local_path: executable },
          });
          const opened = await call("open_binary", { path: app });
          expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
          expect(opened.structuredContent).toMatchObject({
            result: { path: executable, format: "mach-o" },
          });
          expect((await call("close_binary", {})).isError).not.toBe(true);
          expect(await readFile(info, "utf8")).toBe(source);
          expect((await readFile(executable)).equals(original)).toBe(true);
        }
      },
      45_000,
    );
  },
);
