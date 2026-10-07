import { execFile, spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { inspectModuleBoundaries } from "../../scripts/lib/module-boundaries.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const verifier = resolve("scripts/verify-module-boundaries.mjs");

describe("incremental module import boundaries", () => {
  it.each([
    ["src/domain/probe.ts", "../application/Workflow.js", false],
    ["src/domain/probe.ts", "../browser/Provider.js", false],
    ["src/contracts/probe.ts", "../android/Provider.js", false],
    ["src/contracts/probe.ts", "../cli.js", false],
    ["src/contracts/probe.ts", "../composition/android.js", false],
    ["src/domain/probe.test.ts", "../composition/firmware.js", false],
    ["src/application/probe.ts", "../android/JadxProvider.js", false],
    ["src/application/probe.ts", "../composition/android.js", false],
    ["src/server/probe.ts", "../firmware/FirmwareProvider.js", false],
    ["src/server/probe.ts", "../browser/CdpBrowserProvider.js", false],
    ["src/application/probe.ts", "../inspector/V8InspectorProvider.js", false],
    ["src/server/probe.ts", "../inspector/V8InspectorEndpoint.js", false],
    ["src/composition/probe.ts", "../inspector/V8InspectorProvider.js", true],
    ["src/composition/probe.ts", "../browser/CdpBrowserProvider.js", true],
    [
      "src/application/probe.ts",
      "../javascript/recovery/WakaruProvider.js",
      false,
    ],
    ["src/domain/probe.ts", "../javascript/recovery/WakaruReport.js", false],
    ["src/server/probe.ts", "../javascript/recovery/WakaruProvider.js", false],
    ["src/domain/probe.ts", "./result.js", true],
    ["src/contracts/probe.ts", "../domain/result.js", true],
    ["src/application/probe.ts", "../domain/result.js", true],
    ["src/composition/probe.ts", "../ghidra/Provider.js", true],
    ["src/composition/probe.ts", "../android/JadxProvider.js", true],
    ["src/composition/probe.ts", "../firmware/FirmwareProvider.js", true],
    ["src/domain/android/probe.ts", "./types.js", true],
    ["src/domain/javascript/probe.ts", "./types.js", true],
    ["src/domain/inspector/probe.ts", "./types.js", true],
    ["src/domain/firmware/probe.ts", "../android/types.js", true],
    ["src/domain/android/probe.ts", "../../android/JadxProvider.js", false],
    ["src/application/android/probe.ts", "../../domain/android/types.js", true],
    [
      "src/application/android/probe.ts",
      "../../android/JadxProvider.js",
      false,
    ],
    ["src/application/runtime.ts", "../android/JadxProvider.js", true],
    [
      "src/application/android/runtime.ts",
      "../../android/JadxProvider.js",
      false,
    ],
    [
      "src/application/probe.test.ts",
      "../browser/CdpBrowserProvider.js",
      false,
    ],
    ["src/domain/probe.test.ts", "../dotnet/ManagedMemberInspector.js", false],
    ["src/server/probe.ts", "../composition/android.js", true],
    ["src/application/probe.ts", "../browser/CdpCaptureValues.js", true],
    ["src/hopper/probe.ts", "../generatedMcpToolCatalog.js", false],
    ["src/ghidra/probe.ts", "../generatedMcpToolCatalog.ts", false],
    ["src/ida/probe.ts", "../generatedMcpToolCatalog.js", false],
    ["src/artifacts/probe.ts", "../generatedMcpToolCatalog.js", false],
    ["src/browser/probe.ts", "../generatedMcpToolCatalog.js", false],
    ["src/ghidra/probe.ts", "../generatedPackageMetadata.js", true],
    ["src/hopper/probe.ts", "../contracts/officialToolContracts.js", true],
    [
      "src/application/binary/probe.ts",
      "../../generatedMcpToolCatalog.js",
      true,
    ],
  ])("checks %s importing %s", async (file, dependency, allowed) => {
    const temporary = await createTestTempDirectory("rea-module-boundary-");
    const fixture = join(temporary, file);
    await mkdir(dirname(fixture), { recursive: true });
    await writeFile(
      fixture,
      `import { value } from ${JSON.stringify(dependency)}; export { value };\n`,
    );
    const result = spawnSync(process.execPath, [verifier, file], {
      cwd: temporary,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(allowed ? 0 : 1);
    if (!allowed) expect(result.stderr).toContain("resolves to src/");
  });
});

describe("module import syntax and source discovery", () => {
  it.each([
    'import { value } from "../android/Provider.js";',
    'import type { Value } from "../android/Provider.js";',
    'export { value } from "../android/Provider.js";',
    'export * from "../android/Provider.js";',
    'type Value = import("../android/Provider.js").Value;',
    'const loaded = import("../android/Provider.js");',
    "const loaded = import(`../android/Provider.js`);",
    'import provider = require("../android/Provider.js");',
    'import { value } from "../domain/../android/Provider.js";',
    'const loaded = import("../%61ndroid/Provider.js?view=one#fragment");',
  ])("checks the resolved owner in %s", (source) => {
    expect(
      inspectModuleBoundaries("src/domain/probe.ts", source, process.cwd()),
    ).toEqual([
      expect.objectContaining({
        target: "src/android/Provider.js",
        boundary: "pure-layer",
      }),
    ]);
  });

  it("ignores imports mentioned in comments and analyst fixture strings", () => {
    expect(
      inspectModuleBoundaries(
        "src/domain/probe.ts",
        '// import("../android/Provider.js");\nconst text = \'import("../android/Provider.js")\';',
        process.cwd(),
      ),
    ).toEqual([]);
  });

  it.each(["absolute", "file-url"])("resolves %s source imports", (kind) => {
    const target = resolve("src/android/Provider.js");
    const specifier = kind === "file-url" ? pathToFileURL(target).href : target;
    expect(
      inspectModuleBoundaries(
        "src/domain/probe.ts",
        `export * from ${JSON.stringify(specifier)};`,
        process.cwd(),
      ),
    ).toEqual([
      expect.objectContaining({
        target: "src/android/Provider.js",
        boundary: "pure-layer",
      }),
    ]);
  });

  it("rejects unsupported selected arguments instead of checking zero files", () => {
    const result = spawnSync(process.execPath, [verifier, "--unknown"], {
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected an exact TypeScript source file");
  });

  it("reports malformed source with the selected file and parsing reason", async () => {
    const temporary = await createTestTempDirectory("rea-module-syntax-");
    await mkdir(join(temporary, "src", "domain"), { recursive: true });
    await writeFile(join(temporary, "src/domain/probe.ts"), "import {");
    const result = spawnSync(
      process.execPath,
      [verifier, "src/domain/probe.ts"],
      {
        cwd: temporary,
        encoding: "utf8",
      },
    );
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not inspect src/domain/probe.ts");
    expect(result.stderr).toContain("Unexpected token");
  });

  it("checks untracked source files and ignores cached paths removed during a move", async () => {
    const temporary = await createTestTempDirectory("rea-module-discovery-");
    await mkdir(join(temporary, "src", "domain"), { recursive: true });
    await writeFile(join(temporary, "src/domain/old.ts"), "export const x=1;");
    await execute("git", ["init", "--quiet"], { cwd: temporary });
    await execute("git", ["add", "--", "src"], { cwd: temporary });
    await rename(
      join(temporary, "src/domain/old.ts"),
      join(temporary, "src/domain/new.ts"),
    );
    await writeFile(
      join(temporary, "src/domain/probe.ts"),
      'export * from "../android/Provider.js";',
    );
    const result = spawnSync(process.execPath, [verifier], {
      cwd: temporary,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/domain/probe.ts:1: pure-layer");
    expect(result.stderr).not.toContain("old.ts");
  });
});

describe("test lane import boundaries", () => {
  it.each([
    ["src/application/probe.test.ts", "../server/createServer.js", false],
    ["tests/composition/probe.test.ts", "node:child_process", false],
    ["tests/composition/probe.test.ts", "node:net", false],
    ["tests/composition/probe.test.ts", "playwright", false],
    ["tests/composition/probe.test.ts", "../../src/domain/result.js", true],
  ])("checks %s importing %s", async (file, dependency, allowed) => {
    const temporary = await createTestTempDirectory("rea-test-lane-");
    const config = join(temporary, ".oxlintrc.json");
    await copyFile(resolve(".oxlintrc.json"), config);
    await mkdir(dirname(join(temporary, file)), { recursive: true });
    await writeFile(
      join(temporary, file),
      `import { value } from ${JSON.stringify(dependency)}; export { value };\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/oxlint/bin/oxlint"),
        "-c",
        config,
        "--format",
        "json",
        file,
      ],
      { cwd: temporary, encoding: "utf8" },
    );
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(allowed ? 0 : 1);
    if (!allowed) expect(result.stdout).toContain("no-restricted-imports");
  });
});
