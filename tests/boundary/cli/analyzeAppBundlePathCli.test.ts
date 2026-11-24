import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { pe, thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// An unknown standing provider stops native analysis before any engine runs.
const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "missing-provider",
} as const;

const fixtureApp = async () => {
  const directory = await createTestTempDirectory("rea-analyze-app-path-");
  const contents = join(directory, "Sample.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "MacOS/Sample"),
    thinMach(0xfeedfacf, 0x100000c),
  );
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Sample</string></dict></plist>",
  );
  return directory;
};

describe("analyze app bundle path spellings", () => {
  cliTest.for([
    "Sample.app",
    "Sample.app/",
    "Sample.app/.",
    "Sample.app//",
    ...(process.platform === "win32" ? [] : ["bundle-alias"]),
  ])("routes %s to native provider selection", async (path, { cli }) => {
    const cwd = await fixtureApp();
    if (path === "bundle-alias")
      await symlink(join(cwd, "Sample.app"), join(cwd, path));
    const result = await cli.run({
      arguments: ["analyze", path, "--json"],
      cwd,
      environment,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      details: {
        operation: "open_binary",
        selection_reason: "unknown_provider",
        requested_provider_id: "missing-provider",
      },
    });
  });
});

cliTest(
  "routes an ordinary JavaScript directory named .app through the static application lane",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analyze-js-app-name-");
    const app = join(root, "web.app");
    await mkdir(app);
    await writeFile(join(app, "package.json"), '{"main":"main.js"}');
    await writeFile(join(app, "main.js"), "export const marker = 1;\n");
    const result = await cli.run({
      arguments: ["analyze", app, "--json"],
      cwd: root,
      environment,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "analyze_javascript_application",
    });
  },
);

cliTest(
  "refuses a native build directory without JavaScript inputs and names the directory-capable operations",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analyze-native-dir-");
    const build = join(root, "build");
    await mkdir(join(build, "CMakeFiles"), { recursive: true });
    // Native images only; no JavaScript, HTML, package.json or ASAR.
    await writeFile(join(build, "tool.exe"), pe(0x8664));
    await writeFile(join(build, "runtime.dll"), pe(0x8664, 64, 0x2002));
    await writeFile(join(build, "ctest.json"), '{"tests":[]}');
    await writeFile(join(build, "CMakeFiles", "cmake.check_cache"), "x\n");
    const result = await cli.run({
      arguments: ["analyze", build, "--json"],
      cwd: root,
      environment,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "analyze_javascript_application",
        related_operations: [
          "inspect_desktop_application",
          "audit_release_exposure",
          "inspect_artifact",
          "open_binary",
        ],
        diagnostics: {
          inventoried_entries: 4,
          entries_by_format: { file: 2, pe: 2 },
          json_files: 1,
        },
      },
    });
  },
);

cliTest(
  "analyzes an empty directory with an explicit no-input limitation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analyze-empty-dir-");
    const empty = join(root, "empty");
    await mkdir(empty);
    const result = await cli.run({
      arguments: ["analyze", empty, "--json"],
      cwd: root,
      environment,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "analyze_javascript_application",
    });
    expect(result.stdout).toContain("No JavaScript inputs were found");
  },
);

cliTest(
  "keeps analyzing a directory whose only application input is an HTML page",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analyze-html-dir-");
    const site = join(root, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<!doctype html><p>x</p>\n");
    await writeFile(join(site, "data.json"), "{}");
    const result = await cli.run({
      arguments: ["analyze", site, "--json"],
      cwd: root,
      environment,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "analyze_javascript_application",
    });
  },
);
