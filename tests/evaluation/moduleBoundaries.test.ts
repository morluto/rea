import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { inspectModuleBoundaries } from "../../scripts/lib/module-boundaries.mjs";
import { projectForTest } from "../../scripts/lib/test-projects.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { writeRepositoryOxlintConfiguration } from "../fixtures/oxlintConfiguration.js";

describe("process capture implementation ownership", () => {
  it.each([
    ["../../application/process/ProcessEvidence.js", false],
    ["../../composition/binary.js", false],
    ["../../server/createServer.js", false],
    ["../../cli.ts", false],
    ["../../main.js", false],
    ["../../domain/process/processEvidenceProvider.js", true],
    ["../ProcessOwnership.js", true],
    ["../../windows/WindowsOwnedProcess.js", true],
    ["./TerminalRenderer.js", true],
  ])("checks capture importing %s", (dependency, allowed) => {
    const violations = inspectModuleBoundaries(
      "src/process/capture/ProcessHarness.ts",
      `import { value } from "${dependency}";`,
      process.cwd(),
    );
    if (allowed) expect(violations).toEqual([]);
    else expect(violations).toMatchObject([{ boundary: "process-capture" }]);
  });
});

describe("binary production construction ownership", () => {
  it.each([
    "hopper/HopperProvider.js",
    "ghidra/GhidraProvider.js",
    "ida/IdaProvider.js",
    "artifacts/ArtifactProvider.js",
    "dotnet/ManagedStaticProvider.js",
    "native/NativeMacOSProvider.js",
  ])("keeps %s in production composition", (provider) => {
    const source = `import { Provider } from "../${provider}";`;
    for (const file of ["src/application/runtime.ts", "src/server/probe.ts"])
      expect(
        inspectModuleBoundaries(file, source, process.cwd()),
      ).toMatchObject([{ boundary: "provider-construction" }]);
    expect(
      inspectModuleBoundaries(
        "src/composition/binary.ts",
        source,
        process.cwd(),
      ),
    ).toEqual([]);
  });

  it("rejects an application module that re-exports composition", () => {
    expect(
      inspectModuleBoundaries(
        "src/application/runtime.ts",
        'export { createBinarySession } from "../composition/binary.js";',
        process.cwd(),
      ),
    ).toMatchObject([{ boundary: "application-composition" }]);
  });
});

describe("live capability constructor ownership", () => {
  it.each([
    "frida/FridaInstrumentationManager.js",
    "cutter/CutterBridgeClient.js",
    "cutter/CutterBridgeService.js",
    "gdb/GdbSessionManager.js",
    "rizin/RizinDebugSessionManager.js",
  ])(
    "keeps %s values in composition while accepting injected type ports",
    (owner) => {
      const source = `import { Constructor as Alias } from "../${owner}";`;
      const types = `import type { Port } from "../${owner}";`;
      for (const file of ["src/application/probe.ts", "src/server/probe.ts"]) {
        expect(
          inspectModuleBoundaries(file, source, process.cwd()),
        ).toMatchObject([{ boundary: "provider-construction" }]);
        expect(inspectModuleBoundaries(file, types, process.cwd())).toEqual([]);
      }
      expect(
        inspectModuleBoundaries(
          "src/composition/probe.ts",
          source,
          process.cwd(),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    [
      'import { Constructor as Alias } from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    [
      'import * as Owner from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    [
      'import { type Port, Constructor } from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    [
      'import { type Port as Alias } from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    ['import "../frida/FridaInstrumentationManager.js";', false],
    [
      'export { Constructor as Alias } from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    [
      'export { type Port as Alias } from "../frida/FridaInstrumentationManager.js";',
      false,
    ],
    ['export type * from "../frida/FridaInstrumentationManager.js";', true],
    ['export * from "../frida/FridaInstrumentationManager.js";', false],
    [
      'type Port = import("../frida/FridaInstrumentationManager.js").Port;',
      true,
    ],
    ['const owner = import("../frida/FridaInstrumentationManager.js");', false],
    ["const owner = import(`../frida/FridaInstrumentationManager.js`);", false],
    [
      'import owner = require("../frida/FridaInstrumentationManager.js");',
      false,
    ],
    [
      'import type Owner = require("../frida/FridaInstrumentationManager.js");',
      true,
    ],
    [
      'import { Constructor } from "../domain/../frida/FridaInstrumentationManager.js";',
      false,
    ],
    [
      'const owner = import("../%66rida/FridaInstrumentationManager.js?view=one#part");',
      false,
    ],
  ])("checks type/value ownership in %s", (source, allowed) => {
    const violations = inspectModuleBoundaries(
      "src/server/probe.ts",
      source,
      process.cwd(),
    );
    if (allowed) expect(violations).toEqual([]);
    else
      expect(violations).toMatchObject([{ boundary: "provider-construction" }]);
  });

  it("does not broaden the new guard to other provider-owned policy helpers", () => {
    expect(
      inspectModuleBoundaries(
        "src/server/probe.ts",
        'import { policy } from "../frida/fridaCaptureLimits.js";',
        process.cwd(),
      ),
    ).toEqual([]);
  });

  it.each([
    "src/frida/FridaInstrumentationManager.test.ts",
    "src/frida/nested/FutureProvider.test.ts",
  ])("assigns %s to the adapter test project", (path) => {
    expect(projectForTest(path).name).toBe("adapters");
  });
});

const execute = promisify(execFile);
const verifier = resolve("scripts/verify-module-boundaries.mjs");

const resolvePackageImport = (
  root: string,
  file: string,
  specifier: string,
) => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "-e",
      "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
      specifier,
      pathToFileURL(join(root, file)).href,
    ],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return fileURLToPath(result.stdout.trim());
};

describe("incremental module import boundaries", () => {
  it.each([
    ["src/domain/probe.ts", "../application/Workflow.js", false],
    ["src/domain/probe.ts", "../browser/Provider.js", false],
    ["src/contracts/probe.ts", "../android/Provider.js", false],
    ["src/contracts/probe.ts", "../cli.js", false],
    ["src/contracts/probe.ts", "../composition/android.js", false],
    [
      "src/artifacts/javascript/probe.ts",
      "../../application/javascript/JavaScriptArtifactReconstruction.js",
      false,
    ],
    [
      "src/artifacts/javascript/probe.ts",
      "../../composition/android.js",
      false,
    ],
    ["src/artifacts/javascript/probe.ts", "../../cli.js", false],
    [
      "src/artifacts/ArtifactHash.ts",
      "../application/artifacts/ArtifactExtractionDestination.js",
      false,
    ],
    [
      "src/artifacts/javascript/probe.ts",
      "../../domain/artifactInventorySnapshot.js",
      true,
    ],
    ["src/artifacts/javascript/probe.ts", "../AsarArtifactReader.js", true],
    [
      "src/application/javascript/probe.ts",
      "../../artifacts/AsarArtifactReader.js",
      false,
    ],
    [
      "src/application/javascript/probe.ts",
      "../../resources/DirectoryArtifactReader.js",
      false,
    ],
    [
      "src/application/javascript/probe.ts",
      "../../artifacts/javascript/JavaScriptArtifactReader.js",
      true,
    ],
    ["src/artifacts/inventory/probe.ts", "../AsarArtifactReader.js", true],
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
    ["src/application/runtime.ts", "../android/JadxProvider.js", false],
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
    ["src/ghidra/probe.ts", "../generatedPackageMetadata.js", true],
    ["src/hopper/probe.ts", "../contracts/officialToolContracts.js", true],
  ])("checks %s importing %s", (file, dependency, allowed) => {
    const violations = inspectModuleBoundaries(
      file,
      `import { value } from ${JSON.stringify(dependency)}; export { value };\n`,
      process.cwd(),
    );
    if (allowed) expect(violations).toEqual([]);
    else
      expect(violations).toMatchObject([
        { file, boundary: expect.any(String) },
      ]);
  });
});

describe("package-map module ownership", () => {
  it.each([
    ["./dist/composition/worker.js"],
    ["./dist/%63omposition/worker.js"],
    ["./%64ist/composition/worker.js"],
  ])("checks the package-map source owner for %s", async (target) => {
    const root = await createTestTempDirectory("rea-module-package-");
    await mkdir(join(root, "src/application"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ imports: { "#worker": target } }),
    );
    const file = "src/application/probe.ts";
    await writeFile(join(root, file), 'import "#worker";\n');
    expect(resolvePackageImport(root, file, "#worker")).toBe(
      join(root, "dist/composition/worker.js"),
    );
    const checked = spawnSync(process.execPath, [verifier, file], {
      cwd: root,
      encoding: "utf8",
    });
    if (checked.error !== undefined) throw checked.error;
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain(
      "application-composition: #worker resolves to src/composition/worker.ts",
    );
  });

  it.each([
    [
      "#worker",
      {
        "#worker": {
          import: "./dist/composition/worker.js",
          default: "./dist/composition/other.js",
        },
      },
    ],
    ["#worker", { "#worker": ["./dist/composition/worker.js"] }],
    ["#workers/worker", { "#workers/*": "./dist/composition/*.js" }],
  ])(
    "fails closed for unsupported package map %s",
    async (specifier, imports) => {
      const root = await createTestTempDirectory("rea-module-package-");
      await mkdir(join(root, "src/domain"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ imports }));
      const file = "src/domain/probe.ts";
      await writeFile(
        join(root, file),
        `import ${JSON.stringify(specifier)};\n`,
      );
      expect(resolvePackageImport(root, file, specifier)).toBe(
        join(root, "dist/composition/worker.js"),
      );
      const checked = spawnSync(process.execPath, [verifier, file], {
        cwd: root,
        encoding: "utf8",
      });
      if (checked.error !== undefined) throw checked.error;
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain("Cannot resolve package import");
      expect(checked.stderr).toContain("relative source import");
    },
  );
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
    // Only the declared localPath -> HostPlatform import is exempt (see
    // LAYER_EXCEPTIONS); the same import from another domain file is not.
    expect(
      inspectModuleBoundaries(
        "src/domain/localPath.ts",
        'import { HOST_PLATFORM } from "../platform/HostPlatform.js";',
        process.cwd(),
      ),
    ).toEqual([]);
    expect(
      inspectModuleBoundaries(
        "src/domain/probe.ts",
        'import { HOST_PLATFORM } from "../platform/HostPlatform.js";',
        process.cwd(),
      ),
    ).toEqual([expect.objectContaining({ boundary: "pure-layer" })]);
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

  it("discovers forbidden nested sources without a Git worktree", async () => {
    const temporary = await createTestTempDirectory("rea-module-no-git-");
    await mkdir(join(temporary, "src", "domain", "nested"), {
      recursive: true,
    });
    await writeFile(
      join(temporary, "src/domain/nested/probe.ts"),
      'import { createServer } from "../../server/createServer.js";\n',
    );
    const result = spawnSync(process.execPath, [verifier], {
      cwd: temporary,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/domain/nested/probe.ts");
    expect(result.stderr).toContain("src/server/createServer.js");
  });

  it("discovers sources in an ignored archive nested under an ancestor Git worktree", async () => {
    const outer = await createTestTempDirectory("rea-module-ancestor-git-");
    const archive = join(outer, "archive");
    await writeFile(join(outer, ".gitignore"), "archive/\n");
    await execute("git", ["init", "--quiet"], { cwd: outer });
    await execute("git", ["add", "--", ".gitignore"], { cwd: outer });
    await mkdir(join(archive, "src", "domain"), { recursive: true });
    await writeFile(
      join(archive, "src/domain/probe.ts"),
      'import { createServer } from "../server/createServer.js";\n',
    );

    const result = spawnSync(process.execPath, [verifier], {
      cwd: archive,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/domain/probe.ts:1: pure-layer");
    expect(result.stderr).toContain("src/server/createServer.js");
  });
});

describe("test lane import boundaries", () => {
  const cases: Array<[string, string, boolean]> = [
    ["src/application/probe.test.ts", "../server/createServer.js", false],
    ["tests/composition/process.test.ts", "node:child_process", false],
    ["tests/composition/net.test.ts", "node:net", false],
    ["tests/composition/browser.test.ts", "playwright", false],
    ["tests/composition/domain.test.ts", "../../src/domain/result.js", true],
  ];

  it("checks the test-lane import matrix in one lint invocation", async () => {
    const temporary = await createTestTempDirectory("rea-test-lane-");
    const config = await writeRepositoryOxlintConfiguration(temporary);
    for (const [file, dependency] of cases) {
      await mkdir(dirname(join(temporary, file)), { recursive: true });
      await writeFile(
        join(temporary, file),
        `import { value } from ${JSON.stringify(dependency)}; export { value };\n`,
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/oxlint/bin/oxlint"),
        "-c",
        config,
        "--threads",
        "1",
        "--format",
        "json",
        ...cases.map(([file]) => file),
      ],
      { cwd: temporary, encoding: "utf8" },
    );
    if (result.error !== undefined) throw result.error;
    expect(
      result.stdout.trimStart().startsWith("{"),
      `oxlint exited ${String(result.status)} (${String(result.signal)}): ${result.stdout}\n${result.stderr}`,
    ).toBe(true);
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>;
    };
    const violations = new Set(
      report.diagnostics
        .filter(({ code }) => code === "eslint(no-restricted-imports)")
        .map(({ filename }) => filename.replaceAll("\\", "/")),
    );
    for (const [file, , allowed] of cases)
      expect(violations.has(file)).toBe(!allowed);
    expect(result.status).toBe(cases.some(([, , allowed]) => !allowed) ? 1 : 0);
  });
});

describe.each(["apple", "inventory", "extraction"])(
  "%s artifact producer ownership",
  (owner) => {
    it.each([
      ["../../application/Workflow.js", false],
      ["../../composition/android.js", false],
      ["../../cli.js", false],
      ["../../server/registerEvidenceTools.js", false],
      ["../../main.ts", false],
      ["../../domain/apple/plistValue.js", true],
      ["../../domain/artifactInventorySnapshot.js", true],
      ["../../contracts/artifactGraph.js", true],
      ["../AsarArtifactReader.js", true],
      ["../ArtifactHash.js", true],
    ])("checks the producer dependency %s", (dependency, allowed) => {
      const violations = inspectModuleBoundaries(
        `src/artifacts/${owner}/probe.ts`,
        `import type { Value } from ${JSON.stringify(dependency)};`,
        process.cwd(),
      );

      expect(violations.length === 0).toBe(allowed);
      if (!allowed)
        expect(violations[0]?.boundary).toBe("artifact-acquisition");
    });
  },
);

describe("layer baseline ratchet", () => {
  const baselineFile = "scripts/lib/module-layers.baseline.json";

  /** A tree with one native -> application import and the given baseline. */
  const layeredTree = async (recorded: number) => {
    const root = await createTestTempDirectory("rea-module-layers-");
    await mkdir(join(root, "src", "native"), { recursive: true });
    await mkdir(join(root, "src", "application"), { recursive: true });
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    await writeFile(
      join(root, "src/application/Port.ts"),
      "export type P = 1;\n",
    );
    await writeFile(
      join(root, "src/native/Provider.ts"),
      'import type { P } from "../application/Port.js";\nexport type Q = P;\n',
    );
    const upward = recorded > 0 ? { "native -> application": recorded } : {};
    await writeFile(
      join(root, baselineFile),
      `${JSON.stringify({ upward, cycles: [] }, null, 2)}\n`,
    );
    return root;
  };
  const run = (root: string, ...flags: string[]) => {
    const result = spawnSync(process.execPath, [verifier, ...flags], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    return result;
  };
  const recorded = async (root: string): Promise<unknown> =>
    JSON.parse(await readFile(join(root, baselineFile), "utf8"));

  it("fails on a recorded count above the observed imports", async () => {
    const root = await layeredTree(2);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "upward import native -> application: 1, baseline 2",
    );
    expect(await recorded(root)).toEqual({
      upward: { "native -> application": 2 },
      cycles: [],
    });
  });

  it("lowers a stale count when asked and then passes", async () => {
    const root = await layeredTree(2);
    expect(run(root, "--shrink-layer-baseline").status).toBe(0);
    expect(await recorded(root)).toEqual({
      upward: { "native -> application": 1 },
      cycles: [],
      crossProvider: {},
      entry: {},
    });
    expect(run(root).status).toBe(0);
  });

  it("refuses to record growth when asked to shrink", async () => {
    const root = await layeredTree(0);
    const result = run(root, "--shrink-layer-baseline");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "upward import native -> application: 1 imports, baseline 0",
    );
    expect(await recorded(root)).toEqual({ upward: {}, cycles: [] });
  });

  it("does not lower the baseline while a source file cannot be inspected", async () => {
    const root = await layeredTree(1);
    // The unparsable file holds the tree's only native -> application import.
    await writeFile(
      join(root, "src/native/Provider.ts"),
      "export type Q = 1;\n",
    );
    await writeFile(
      join(root, "src/native/Broken.ts"),
      'import type { P } from "../application/Port.js";\nimport {',
    );
    const result = run(root, "--shrink-layer-baseline");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not inspect src/native/Broken.ts");
    expect(await recorded(root)).toEqual({
      upward: { "native -> application": 1 },
      cycles: [],
    });
  });

  /**
   * A tree with one import of another provider folder, one composition import
   * past ghidra's entry files (beside an import of a declared one) and one
   * import of a toolkit file past src/resources/index.ts.
   */
  const providerTree = async (baseline: object) => {
    const root = await createTestTempDirectory("rea-provider-boundaries-");
    const files: Record<string, string> = {
      "src/native/Reader.ts": "export type R = 1;\n",
      "src/gpu/Probe.ts":
        'import type { R } from "../native/Reader.js";\nexport type G = R;\n',
      "src/ghidra/Doctor.ts": "export type D = 1;\n",
      "src/ghidra/GhidraDoctor.ts": 'export type { D } from "./Doctor.js";\n',
      "src/composition/ghidra.ts":
        'import type { D } from "../ghidra/Doctor.js";\nimport type { D as E } from "../ghidra/GhidraDoctor.js";\nexport type C = D | E;\n',
      "src/resources/Scope.ts": "export type S = 1;\n",
      "src/resources/index.ts": 'export type { S } from "./Scope.js";\n',
      "src/process/Lease.ts":
        'import type { S } from "../resources/Scope.js";\nexport type L = S;\n',
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    await writeFile(
      join(root, baselineFile),
      `${JSON.stringify({ upward: {}, cycles: [], ...baseline }, null, 2)}\n`,
    );
    return root;
  };

  it("fails on provider boundary imports the baseline does not record", async () => {
    const root = await providerTree({});
    const result = run(root, "--shrink-layer-baseline");
    expect(result.status).toBe(1);
    for (const finding of [
      "cross-provider import gpu -> native: 1 imports, baseline 0",
      "import past the entry file composition -> ghidra: 1 imports, baseline 0",
      "import past the entry file process -> resources: 1 imports, baseline 0",
    ])
      expect(result.stderr).toContain(finding);
    expect(await recorded(root)).toEqual({ upward: {}, cycles: [] });
  });

  it("lowers stale provider boundary counts when asked and then passes", async () => {
    const root = await providerTree({
      crossProvider: { "gpu -> native": 2, "go -> native": 1 },
      entry: { "composition -> ghidra": 3, "process -> resources": 1 },
    });
    const stale = run(root);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(
      "cross-provider import gpu -> native: 1, baseline 2",
    );
    expect(run(root, "--shrink-layer-baseline").status).toBe(0);
    expect(await recorded(root)).toEqual({
      upward: {},
      cycles: [],
      crossProvider: { "gpu -> native": 1 },
      entry: { "composition -> ghidra": 1, "process -> resources": 1 },
    });
    expect(run(root).status).toBe(0);
  });
});
