import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import {
  FILE_TYPE,
  LC,
  dylibCommand,
  machoImage,
  rpathCommand,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { dylibResolutionResultSchema } from "../../../src/domain/apple/dylibResolution.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const ENVIRONMENT = { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" };

const writeFiles = async (
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const fixtureApp = async (): Promise<string> => {
  const app = join(
    await createTestTempDirectory("rea-dylib-cli-"),
    "Fixture.app",
  );
  await writeFiles(app, {
    "Contents/Info.plist":
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    "Contents/MacOS/App": machoImage({
      commands: [
        rpathCommand("@executable_path/../Frameworks"),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
        dylibCommand(LC.LOAD_WEAK_DYLIB, "@rpath/libgone.dylib"),
      ],
    }),
    "Contents/Frameworks/libcore.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [dylibCommand(LC.ID_DYLIB, "@rpath/libcore.dylib")],
    }),
    "Contents/Helpers/tool": machoImage({
      commands: [dylibCommand(LC.LOAD_DYLIB, "@loader_path/libnone.dylib")],
    }),
  });
  return app;
};

const withBrokenHelper = async (app: string): Promise<void> => {
  const broken = machoImage({ commands: [rpathCommand("x")] });
  // cmdsize 0 makes the command table unreadable.
  new DataView(broken.buffer).setUint32(32 + 4, 0, true);
  await writeFiles(app, { "Contents/Helpers/broken": broken });
};

describe("trace-dylib-resolution CLI", () => {
  cliTest("traces every executable root of an app bundle", async ({ cli }) => {
    const app = await fixtureApp();
    const result = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      (result.json as { normalized_result: unknown }).normalized_result,
    );
    expect(trace.root_path).toBe(app);
    expect(trace.roots.map(({ image }) => image)).toEqual([
      "Contents/Helpers/tool",
      "Contents/MacOS/App",
    ]);
    expect(
      trace.edges.map(({ loader, install_name: name, resolution }) => [
        loader,
        name,
        resolution.status,
        resolution.image,
      ]),
    ).toEqual([
      [
        "Contents/Helpers/tool",
        "@loader_path/libnone.dylib",
        "unresolved",
        null,
      ],
      [
        "Contents/MacOS/App",
        "@rpath/libcore.dylib",
        "resolved",
        "Contents/Frameworks/libcore.dylib",
      ],
      ["Contents/MacOS/App", "@rpath/libgone.dylib", "unresolved", null],
    ]);
    expect(trace.findings.map(({ kind }) => kind)).toEqual([
      "required-load-unresolved",
      "weak-load-unresolved",
    ]);
    expect(
      trace.images.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)),
    ).toBe(true);
  });

  cliTest(
    "narrows roots and architecture, and rejects escaping roots",
    async ({ cli }) => {
      const app = await fixtureApp();
      const narrowed = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          app,
          "--root",
          "Contents/MacOS/App",
          "--architecture",
          "arm64",
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(narrowed.exitCode).toBe(0);
      expect(
        (narrowed.json as { normalized_result: { roots: unknown } })
          .normalized_result.roots,
      ).toEqual([{ image: "Contents/MacOS/App", architecture: "arm64" }]);
      // A root below a symlinked directory that points outside the bundle.
      const outside = await createTestTempDirectory("rea-dylib-outside-");
      await writeFiles(outside, { Tool: machoImage({}) });
      await symlink(outside, join(app, "Contents/Linked"));
      for (const root of [
        "../outside",
        "Contents/Info.plist",
        "Contents/Linked/Tool",
      ]) {
        const rejected = await cli.run({
          arguments: ["trace-dylib-resolution", app, "--root", root, "--json"],
          environment: ENVIRONMENT,
        });
        expect(rejected.exitCode).toBe(1);
        expect(rejected.json).toMatchObject({ error: "Analysis failed" });
      }
    },
  );

  cliTest(
    "resolves a standalone Mach-O against its own directory",
    async ({ cli }) => {
      const directory = await createTestTempDirectory("rea-dylib-standalone-");
      await writeFiles(directory, {
        tool: machoImage({
          commands: [
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/lib/libhelper.dylib"),
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/../escape.dylib"),
          ],
        }),
        "lib/libhelper.dylib": machoImage({ fileType: FILE_TYPE.dylib }),
        "unrelated.txt": "not traversed",
      });
      const result = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          join(directory, "tool"),
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.roots).toEqual([{ image: "tool", architecture: "arm64" }]);
      expect(trace.edges.map(({ resolution }) => resolution)).toEqual([
        { status: "resolved", image: "lib/libhelper.dylib" },
        { status: "undetermined", image: null },
      ]);
    },
  );

  cliTest(
    "reports unparsed Mach-O files found while enumerating roots",
    async ({ cli }) => {
      const app = await fixtureApp();
      await withBrokenHelper(app);
      const result = await cli.run({
        arguments: ["trace-dylib-resolution", app, "--json"],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.coverage).toMatchObject({
        status: "partial",
        unparsed_images: ["Contents/Helpers/broken"],
      });
    },
  );
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "trace-dylib-resolution permissions",
  () => {
    cliTest(
      "reports an unreadable dependency as a permission failure",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-dylib-denied-");
        await writeFiles(directory, {
          tool: machoImage({
            commands: [
              dylibCommand(LC.LOAD_DYLIB, "@loader_path/libsecret.dylib"),
            ],
          }),
          "libsecret.dylib": machoImage({ fileType: FILE_TYPE.dylib }),
        });
        await chmod(join(directory, "libsecret.dylib"), 0o000);
        try {
          const result = await cli.run({
            arguments: [
              "trace-dylib-resolution",
              join(directory, "tool"),
              "--json",
            ],
            environment: ENVIRONMENT,
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({
            details: {
              reason: "unavailable",
              detail: expect.stringContaining(
                "Permission denied (EACCES) reading libsecret.dylib",
              ),
            },
          });
        } finally {
          await chmod(join(directory, "libsecret.dylib"), 0o644);
        }
      },
    );
  },
);
