import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  parseTestSelection,
  planTestSelection,
  testShards,
} from "../../scripts/ci/test-selection.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const group = fileURLToPath(
  new URL("../../scripts/ci/test-group.mjs", import.meta.url),
);

const selectedEnvironment = (...files: string[]) => ({
  ...process.env,
  CI_TEST_SELECTION: JSON.stringify({
    version: 3,
    mode: "selected",
    reason: "Explicitly selected test files",
    files,
    shards: 1,
  }),
});

const plan = (files: readonly string[], sources: Record<string, string>) =>
  planTestSelection({
    files,
    event: "pull_request",
    tier: "fast",
    code: true,
    snapshot: {
      list: () => Object.keys(sources),
      read: (paths) =>
        new Map(paths.map((path) => [path, sources[path] ?? ""])),
    },
  });

const selectedFiles = (result: ReturnType<typeof plan>) =>
  (result.mode === "selected" ? result.files : []).toSorted();

it("follows test and verifier imports and directory scans, not production importers", () => {
  const sources = {
    "src/domain/Value.ts": "",
    "src/application/UsesValue.ts": 'import "../domain/Value.js";',
    "src/application/UsesValue.test.ts": 'import "./UsesValue.js";',
    "src/domain/Value.test.ts": 'import { value } from "./Value.js";',
    "src/domain/Registry.test.ts": "readdirSync(here);",
    "src/domain/Unrelated.test.ts": 'import "./Unrelated.js";',
    "tests/boundary/filesystem/verifier.test.ts":
      'const m = await import("../../../scripts/verify-thing.mjs");',
  };
  expect(selectedFiles(plan(["src/domain/Value.ts"], sources))).toEqual([
    "src/domain/Registry.test.ts",
    "src/domain/Value.test.ts",
  ]);
  expect(selectedFiles(plan(["scripts/verify-thing.mjs"], sources))).toEqual([
    "tests/boundary/filesystem/verifier.test.ts",
  ]);
});

it("selects a registry guard when a named test changes or moves", () => {
  const registered =
    "tests/boundary/providers/sampleRegistryProviderCatalog.test.ts";
  const moved = "tests/boundary/providers/sampleRegistryMoved.test.ts";
  const guard = "tests/evaluation/sampleRegistryGuard.test.ts";
  const sources = {
    "tests/support/lifecycleRegistry.ts": `export const paths = ["${registered}"];`,
    "tests/support/lifecycleCoverage.ts":
      'export { paths } from "./lifecycleRegistry.js";',
    [guard]: 'import "../support/lifecycleCoverage.js";',
    "tests/boundary/providers/sampleRegistryUnrelated.test.ts": "",
  };
  expect(
    selectedFiles(plan([registered], { ...sources, [registered]: "" })),
  ).toEqual([registered, guard]);
  expect(selectedFiles(plan([registered], sources))).toEqual([guard]);
  expect(
    selectedFiles(plan([registered, moved], { ...sources, [moved]: "" })),
  ).toEqual([moved, guard]);
});

it("selects a leaf adapter's tests by its name and directory across test projects", () => {
  const sources = {
    "src/jeb/JebMcpDeadline.ts": "",
    "tests/boundary/providers/jebMcpTimeout.test.ts": "",
    "tests/boundary/mcp/jebMcp.test.ts": "",
    "tests/acceptance/providers/jebConfigurationIsolation.test.ts": "",
    "tests/boundary/providers/adb/adbBugreport.test.ts": "",
    "tests/boundary/providers/ghidraJava.test.ts": "",
  };
  expect(selectedFiles(plan(["src/jeb/JebMcpDeadline.ts"], sources))).toEqual([
    "tests/acceptance/providers/jebConfigurationIsolation.test.ts",
    "tests/boundary/mcp/jebMcp.test.ts",
    "tests/boundary/providers/jebMcpTimeout.test.ts",
  ]);
  expect(selectedFiles(plan(["src/adb/AdbProvider.ts"], sources))).toEqual([
    "tests/boundary/providers/adb/adbBugreport.test.ts",
  ]);
});

it("selects tests that start the built runtime beside a changed presentation owner", () => {
  const sources = {
    "src/server/Core.ts": "",
    "src/server/recovery.ts": "",
    "src/domain/Value.ts": "",
    "tests/support/launch.ts": 'spawn("scripts/rea.mjs", ["mcp"]);',
    "tests/fixtures/client.ts": 'import "../support/launch.js";',
    // Starts the built server and imports a sibling of the changed owner.
    "tests/boundary/mcp/direct.test.ts":
      'import "../../../src/server/recovery.js"; resolve("dist/main.js");',
    "tests/boundary/mcp/helper.test.ts":
      'import "../../fixtures/client.js"; import "../../../src/server/recovery.js";',
    // Starts it but imports nothing from that owner, or imports it in process.
    "tests/boundary/mcp/unrelated.test.ts":
      'import "../../fixtures/client.js"; import "../../../src/domain/Value.js";',
    "tests/boundary/mcp/inProcess.test.ts":
      'import "../../../src/server/recovery.js";',
    // A package's own dist/ subpath is not the built runtime.
    "tests/boundary/mcp/ajv.test.ts":
      'import { Ajv2020 } from "ajv/dist/2020.js"; import "../../../src/server/recovery.js";',
  };
  expect(selectedFiles(plan(["src/server/Core.ts"], sources))).toEqual([
    "tests/boundary/mcp/direct.test.ts",
    "tests/boundary/mcp/helper.test.ts",
  ]);
  // Other owners keep import tracing only.
  expect(plan(["src/domain/Value.ts"], sources)).toMatchObject({
    reason: "Affected tests: 1 imports",
  });
});

it("lets checker-only inputs and prose select nothing by themselves", () => {
  const sources = {
    "src/domain/Value.test.ts": "",
    "tests/boundary/filesystem/docs.test.ts": 'read("docs/guide.md");',
    "tests/boundary/filesystem/docsAsset.test.ts":
      'read("docs/assets/example.png");',
    "tests/boundary/filesystem/licenses.test.ts":
      'read("licenses/npm-dependencies.txt"); read("LICENSE");',
    "tests/boundary/filesystem/issueTemplate.test.ts":
      'read(".github/ISSUE_TEMPLATE/bug_report.yml");',
  };
  // A declaration, guard/layer baseline, blame-ignore list or schema summary adds no tests…
  expect(
    selectedFiles(
      plan(
        [
          "src/domain/Value.test.ts",
          "scripts/lib/helper.d.mts",
          "scripts/lib/module-layers.baseline.json",
          ".git-blame-ignore-revs",
          "scripts/verify/baselines/some-guard.json",
          "scripts/verify/fixed-ceiling-registry.json",
          "scripts/verify/untyped-budget-refusal-baseline.json",
          "scripts/verify/advertised-schemas/tools/tool.json",
        ],
        sources,
      ),
    ),
  ).toEqual(["src/domain/Value.test.ts"]);
  // …and prose, non-code docs assets, and license inventories select the tests that read them by path.
  expect(selectedFiles(plan(["docs/guide.md"], sources))).toEqual([
    "tests/boundary/filesystem/docs.test.ts",
  ]);
  expect(selectedFiles(plan(["docs/assets/example.png"], sources))).toEqual([
    "tests/boundary/filesystem/docsAsset.test.ts",
  ]);
  expect(
    selectedFiles(plan(["licenses/npm-dependencies.txt"], sources)),
  ).toEqual(["tests/boundary/filesystem/licenses.test.ts"]);
  expect(selectedFiles(plan(["LICENSE"], sources))).toEqual([
    "tests/boundary/filesystem/licenses.test.ts",
  ]);
  expect(
    selectedFiles(plan([".github/ISSUE_TEMPLATE/bug_report.yml"], sources)),
  ).toEqual(["tests/boundary/filesystem/issueTemplate.test.ts"]);
  // Authored code under docs/ stays untraced so it falls back to the full suite.
  expect(plan(["docs/.vitepress/config.ts"], sources)).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: docs/.vitepress/config.ts",
  });
  expect(plan(["scripts/verify/baselines/x.json"], sources)).toMatchObject({
    mode: "full",
  });
});

it("selects tests under shared-boundary directories and declared fixture owners, failing closed on missing owners", () => {
  const sources = {
    "src/process/OwnedCommand.test.ts": "",
    "tests/boundary/cli/cliParityGoldens.test.ts": "",
    "tests/boundary/cli/cliContractSchemaParity.test.ts": "",
  };
  expect(
    selectedFiles(plan(["src/process/OwnedCommand.test.ts"], sources)),
  ).toEqual(["src/process/OwnedCommand.test.ts"]);
  expect(plan(["src/process/OwnedCommand.ts"], sources)).toMatchObject({
    mode: "full",
    reason: "Shared boundary: src/process/OwnedCommand.ts",
  });
  expect(
    selectedFiles(
      plan(["tests/fixtures/cli-parity/error-unknown-command.txt"], sources),
    ),
  ).toEqual(["tests/boundary/cli/cliParityGoldens.test.ts"]);
  expect(
    selectedFiles(
      plan(
        ["tests/boundary/cli/cliContractSchemaParity.uncomparable.json"],
        sources,
      ),
    ),
  ).toEqual(["tests/boundary/cli/cliContractSchemaParity.test.ts"]);
  // If an explicit fixture owner is missing or renamed, selection fails closed.
  expect(
    plan(["tests/fixtures/cli-parity/error-unknown-command.txt"], {
      "src/process/OwnedCommand.test.ts": "",
    }),
  ).toMatchObject({
    mode: "full",
    reason:
      "Missing test owner tests/boundary/cli/cliParityGoldens.test.ts for tests/fixtures/cli-parity/error-unknown-command.txt",
  });
});

it("selects adapter and packaging tests for every owned bridge group and fails closed otherwise", () => {
  const packagedTests = [
    "tests/boundary/process/packageTarListing.test.ts",
    "tests/boundary/process/packedBridgeVerification.test.ts",
    "tests/conformance/package/packedTarListing.test.ts",
  ];
  const sources: Record<string, string> = {
    "src/ghidra/GhidraRawProfileDigest.test.ts": "",
    "tests/boundary/providers/ghidra/ghidraLauncher.test.ts": "",
    "tests/boundary/filesystem/ghidraBridgeSources.test.ts": "",
    "tests/boundary/providers/hopper/hopperBridgeFacade.test.ts": "",
    "tests/boundary/providers/hopper/hopperBookmarks.test.ts": "",
    "src/ida/IdaHexRaysProtocol.test.ts": "",
    "tests/boundary/providers/ida/idaQuery.test.ts": "",
    "src/cutter/CutterBridge.test.ts": "",
    "tests/boundary/providers/CutterBridgeClient.test.ts": "",
    "src/android/AndroidMetadata.test.ts": "",
    "tests/boundary/android/jadxBridge.test.ts": "",
    "src/desktop/BuildComputerController.test.ts": "",
    "tests/boundary/providers/agentEnvCapture.test.ts": "",
    "tests/boundary/web/mitmproxyCapture.test.ts": "",
    "src/native/NativeUi.test.ts": "",
    "tests/boundary/native/lldbTracer.test.ts": "",
    "tests/boundary/process/darwinProcessRunTokenReader.test.ts": "",
    "tests/boundary/native/PwndbgCoreContext.test.ts": "",
    "tests/boundary/mcp/recordedCrashMcp.test.ts": "",
    "tests/boundary/binaryDiagnostics/pwntoolsDecoderOwnership.test.ts": "",
    "tests/boundary/binaryDiagnostics/binaryLayoutCli.test.ts": "",
    "tests/evaluation/package/nativeAotDiagnostics.test.ts": "",
    "tests/boundary/process/packedBridgeVerification.test.ts": "",
    "tests/boundary/process/packageTarListing.test.ts": "",
    "tests/conformance/package/packedTarListing.test.ts": "",
    "tests/boundary/providers/adb/adbBugreport.test.ts": "",
  };
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "bridge/ghidra/ReaGhidraBridge.java",
      [
        ...packagedTests,
        "src/ghidra/GhidraRawProfileDigest.test.ts",
        "tests/boundary/filesystem/ghidraBridgeSources.test.ts",
        "tests/boundary/providers/ghidra/ghidraLauncher.test.ts",
      ],
    ],
    [
      "bridge/hopper_bridge.py",
      [
        ...packagedTests,
        "tests/boundary/providers/hopper/hopperBookmarks.test.ts",
        "tests/boundary/providers/hopper/hopperBridgeFacade.test.ts",
      ],
    ],
    [
      "bridge/test_hopper_bridge.py",
      [
        "tests/boundary/providers/hopper/hopperBookmarks.test.ts",
        "tests/boundary/providers/hopper/hopperBridgeFacade.test.ts",
      ],
    ],
    [
      "bridge/ida/hexrays_queries.py",
      [
        ...packagedTests,
        "src/ida/IdaHexRaysProtocol.test.ts",
        "tests/boundary/providers/ida/idaQuery.test.ts",
      ],
    ],
    [
      "bridge/cutter/rea_bridge.py",
      [
        ...packagedTests,
        "src/cutter/CutterBridge.test.ts",
        "tests/boundary/providers/CutterBridgeClient.test.ts",
      ],
    ],
    [
      "bridge/android/ReaJadxBridge.java",
      [
        ...packagedTests,
        "src/android/AndroidMetadata.test.ts",
        "tests/boundary/android/jadxBridge.test.ts",
      ],
    ],
    [
      "bridge/agentenv/capture.py",
      [
        ...packagedTests,
        "src/desktop/BuildComputerController.test.ts",
        "tests/boundary/providers/agentEnvCapture.test.ts",
      ],
    ],
    [
      "bridge/mitmproxy/capture.py",
      [...packagedTests, "tests/boundary/web/mitmproxyCapture.test.ts"],
    ],
    [
      "bridge/native/ReaNativeUI.swift",
      [
        ...packagedTests,
        "src/native/NativeUi.test.ts",
        "tests/boundary/native/PwndbgCoreContext.test.ts",
        "tests/boundary/native/lldbTracer.test.ts",
        "tests/evaluation/package/nativeAotDiagnostics.test.ts",
      ],
    ],
    [
      "bridge/native/rea_lldb_tracer.py",
      [
        ...packagedTests,
        "src/native/NativeUi.test.ts",
        "tests/boundary/native/PwndbgCoreContext.test.ts",
        "tests/boundary/native/lldbTracer.test.ts",
        "tests/evaluation/package/nativeAotDiagnostics.test.ts",
      ],
    ],
    [
      "bridge/process/ProcessRunTokenReader.swift",
      [
        ...packagedTests,
        "tests/boundary/process/darwinProcessRunTokenReader.test.ts",
      ],
    ],
    [
      "bridge/pwndbg/core_context.py",
      [
        ...packagedTests,
        "tests/boundary/mcp/recordedCrashMcp.test.ts",
        "tests/boundary/native/PwndbgCoreContext.test.ts",
      ],
    ],
    [
      "bridge/pwntools/layout.py",
      [
        ...packagedTests,
        "tests/boundary/binaryDiagnostics/binaryLayoutCli.test.ts",
        "tests/boundary/binaryDiagnostics/pwntoolsDecoderOwnership.test.ts",
        "tests/boundary/mcp/recordedCrashMcp.test.ts",
      ],
    ],
    [
      "bridge/nativeaot/NativeAotDirectory.java",
      [
        "tests/boundary/filesystem/ghidraBridgeSources.test.ts",
        "tests/boundary/providers/ghidra/ghidraLauncher.test.ts",
        "tests/evaluation/package/nativeAotDiagnostics.test.ts",
      ],
    ],
  ];
  for (const [bridgeFile, expected] of cases)
    expect(selectedFiles(plan([bridgeFile], sources)), bridgeFile).toEqual(
      [...expected].toSorted(),
    );

  const omit = (target: string) =>
    Object.fromEntries(
      Object.entries(sources).filter(([path]) => path !== target),
    );
  // Missing a declared packaging owner fails closed to the full suite.
  expect(
    plan(
      ["bridge/ghidra/ReaGhidraBridge.java"],
      omit("tests/boundary/process/packedBridgeVerification.test.ts"),
    ),
  ).toMatchObject({
    mode: "full",
    reason:
      "Missing test owner tests/boundary/process/packedBridgeVerification.test.ts for bridge/ghidra/ReaGhidraBridge.java",
  });
  // Missing a declared non-packaging owner also fails closed to the full suite.
  expect(
    plan(
      ["bridge/process/ProcessRunTokenReader.swift"],
      omit("tests/boundary/process/darwinProcessRunTokenReader.test.ts"),
    ),
  ).toMatchObject({
    mode: "full",
    reason:
      "Missing test owner tests/boundary/process/darwinProcessRunTokenReader.test.ts for bridge/process/ProcessRunTokenReader.swift",
  });
  expect(
    plan(
      ["bridge/cutter/rea_bridge.py"],
      omit("tests/boundary/providers/CutterBridgeClient.test.ts"),
    ),
  ).toMatchObject({
    mode: "full",
    reason:
      "Missing test owner tests/boundary/providers/CutterBridgeClient.test.ts for bridge/cutter/rea_bridge.py",
  });
  // Unowned or non-code bridge inputs remain untraced and fail closed.
  expect(plan(["bridge/ghidra/notes.txt"], sources)).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: bridge/ghidra/notes.txt",
  });
  expect(plan(["bridge/unknown/helper.py"], sources)).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: bridge/unknown/helper.py",
  });
});

it("includes the declared integration test for managed pointer row changes", () => {
  const changed = "src/domain/managed/managedMemberPointers.ts";
  const direct = "src/dotnet/ManagedMemberPointerBudget.test.ts";
  const owner = "src/dotnet/ManagedMemberPointers.test.ts";
  const sources = {
    [changed]: "",
    [direct]: 'import "../domain/managed/managedMemberPointers.js";',
  };
  expect(selectedFiles(plan([changed], { ...sources, [owner]: "" }))).toEqual([
    direct,
    owner,
  ]);
  expect(plan([changed], sources)).toMatchObject({
    mode: "full",
    reason: `Missing test owner ${owner} for ${changed}`,
  });
});

it("traces shared script modules to their tests and falls back for other consumers", () => {
  const sources = {
    "scripts/lib/shared.mjs": "",
    "scripts/lib/wrapper.mjs": 'export * from "./shared.mjs";',
    "scripts/verify-thing.mjs": 'import "./lib/wrapper.mjs";',
    "scripts/lib/unused.mjs": "",
    "tests/boundary/filesystem/shared.test.ts":
      'import "../../../scripts/lib/shared.mjs";',
    "tests/boundary/filesystem/verifier.test.ts":
      'await import("../../../scripts/verify-thing.mjs");',
    "tests/boundary/filesystem/other.test.ts": "",
    "package.json":
      '{"scripts":{"verify:thing":"node scripts/verify-thing.mjs"}}',
  };
  // Through another shared module and a verifier to the tests that import them.
  expect(selectedFiles(plan(["scripts/lib/shared.mjs"], sources))).toEqual([
    "tests/boundary/filesystem/shared.test.ts",
    "tests/boundary/filesystem/verifier.test.ts",
  ]);
  // Shared fixture modules under scripts/fixtures/ trace to their importing
  // tests and verifiers, while failing closed when a package/build script loads them.
  const fixtureSources = {
    ...sources,
    "scripts/fixtures/managed/pe.mjs": "",
    "scripts/verify/managed/conformance.mjs":
      'import "../../fixtures/managed/pe.mjs";',
    "tests/boundary/providers/dotnet/pe.test.ts":
      'import "../../../../scripts/fixtures/managed/pe.mjs";',
    "tests/boundary/providers/dotnet/conformance.test.ts":
      'const v = "scripts/verify/managed/conformance.mjs";',
  };
  expect(
    selectedFiles(plan(["scripts/fixtures/managed/pe.mjs"], fixtureSources)),
  ).toEqual([
    "tests/boundary/providers/dotnet/conformance.test.ts",
    "tests/boundary/providers/dotnet/pe.test.ts",
  ]);
  expect(
    plan(["scripts/fixtures/managed/pe.mjs"], {
      ...fixtureSources,
      "package.json":
        '{"scripts":{"fixtures:pe":"node scripts/fixtures/managed/pe.mjs"}}',
    }),
  ).toMatchObject({
    mode: "full",
    reason:
      "Script consumer is not traced: package.json uses scripts/fixtures/managed/pe.mjs",
  });
  // A build script, configuration or package script that loads it is untraced.
  expect(
    plan(["scripts/lib/shared.mjs"], {
      ...sources,
      "scripts/build.mjs": 'import { x } from "./lib/wrapper.mjs";',
    }),
  ).toMatchObject({
    mode: "full",
    reason:
      "Script consumer is not traced: scripts/build.mjs uses scripts/lib/wrapper.mjs",
  });
  expect(
    plan(["scripts/lib/shared.mjs"], {
      ...sources,
      "package.json": '{"scripts":{"x":"node scripts/lib/shared.mjs"}}',
    }),
  ).toMatchObject({
    mode: "full",
    reason:
      "Script consumer is not traced: package.json uses scripts/lib/shared.mjs",
  });
  // A module no test reaches runs everything, even beside a selected change.
  for (const files of [
    ["scripts/lib/unused.mjs"],
    ["scripts/lib/unused.mjs", "tests/boundary/filesystem/other.test.ts"],
  ])
    expect(plan(files, sources)).toMatchObject({
      mode: "full",
      reason: "No test reaches shared script module: scripts/lib/unused.mjs",
    });
  // Verifier source loads are module edges, and a test that starts a reached
  // verifier by path is selected without importing it.
  const loaded = {
    "scripts/lib/startup.mts": "",
    "scripts/lib/lifecycle.mjs":
      'await importVerifierSource(new URL("./startup.mts", import.meta.url).href, import.meta.url);',
    "scripts/verify-runtime.mjs": 'import "./lib/lifecycle.mjs";',
    "tests/boundary/filesystem/startup.test.ts":
      'import "../../../scripts/lib/startup.mts";',
    "tests/boundary/filesystem/lifecycle.test.ts":
      'import "../../../scripts/lib/lifecycle.mjs";',
    "tests/boundary/filesystem/runtimeVerifier.test.ts":
      'spawn(process.execPath, ["scripts/verify-runtime.mjs"]);',
  };
  expect(selectedFiles(plan(["scripts/lib/startup.mts"], loaded))).toEqual([
    "tests/boundary/filesystem/lifecycle.test.ts",
    "tests/boundary/filesystem/runtimeVerifier.test.ts",
    "tests/boundary/filesystem/startup.test.ts",
  ]);
  // Static checker JSON/Stryker configs, hyphen-prefixed script names in
  // package.json (such as verify-shared.mjs vs scripts/lib/shared.mjs), and
  // path-string tables in scopes.mjs do not force a full-suite fallback.
  expect(
    selectedFiles(
      plan(
        [
          "scripts/lib/shared.mjs",
          "tests/support/analysis-efficiency/test_eval.py",
        ],
        {
          ...sources,
          "package.json":
            '{"scripts":{"verify:shared":"node scripts/verify-shared.mjs"}}',
          "tsconfig.scripts.json": '{"include":["scripts/lib/shared.mjs"]}',
          "stryker.config.mjs": 'import "./scripts/lib/shared.mjs";',
          "scripts/check-doc-facts.mjs": 'import "./lib/shared.mjs";',
          "scripts/ci/scopes.mjs":
            'export const S = ["scripts/lib/shared.mjs"];',
        },
      ),
    ),
  ).toEqual([
    "tests/boundary/filesystem/shared.test.ts",
    "tests/boundary/filesystem/verifier.test.ts",
  ]);
  expect(
    selectedFiles(
      plan(["tests/fixtures/card.json"], {
        "tests/fixtures/card.json": '{"ok":true}',
        "tests/boundary/mcp/card.test.ts":
          'new URL("../../fixtures/card.json", import.meta.url);',
        "tests/boundary/mcp/unrelated.test.ts": 'import "../../../src/a.js";',
      }),
    ),
  ).toEqual(["tests/boundary/mcp/card.test.ts"]);
  expect(
    plan(["tests/fixtures/unreferenced.bin"], {
      "tests/fixtures/unreferenced.bin": "raw",
      "tests/boundary/mcp/unrelated.test.ts": 'import "../../../src/a.js";',
    }),
  ).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: tests/fixtures/unreferenced.bin",
  });
  expect(
    plan(["scripts/lib/shared.mjs"], {
      ...sources,
      "scripts/ci/scopes.mjs": 'import "../lib/shared.mjs";',
    }),
  ).toMatchObject({
    mode: "full",
    reason:
      "Script consumer is not traced: scripts/ci/scopes.mjs uses scripts/lib/shared.mjs",
  });
  // Other scripts remain untraced inputs.
  expect(plan(["scripts/build.mjs"], sources)).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: scripts/build.mjs",
  });
});

it("traces JavaScript fixture modules transitively through JS and TS helpers", () => {
  const sources = {
    "tests/fixtures/fakeHopperReplies.mjs":
      "export const fakeHopperReply = () => ({});",
    "tests/fixtures/fakeHopper.mjs":
      'import { fakeHopperReply } from "./fakeHopperReplies.mjs"; export { fakeHopperReply };',
    "tests/boundary/providers/hopper/hopperClient.fixture.ts":
      'export const bridge = new URL("../../../fixtures/fakeHopper.mjs", import.meta.url);',
    "tests/boundary/providers/hopper/fakeHopperReplyContracts.test.ts":
      'import { fakeHopperReply } from "../../../fixtures/fakeHopperReplies.mjs"; void fakeHopperReply;',
    "tests/boundary/providers/hopper/hopperSocket.test.ts":
      'import { bridge } from "./hopperClient.fixture.js"; void bridge;',
    "tests/acceptance/providers/hopperStartupRecovery.test.ts":
      'const path = "tests/fixtures/fakeHopper.mjs"; void path;',
    "src/unrelated.test.ts": "",
  };
  expect(plan(["tests/fixtures/fakeHopperReplies.mjs"], sources)).toMatchObject(
    {
      mode: "selected",
      files: [
        "tests/acceptance/providers/hopperStartupRecovery.test.ts",
        "tests/boundary/providers/hopper/fakeHopperReplyContracts.test.ts",
        "tests/boundary/providers/hopper/hopperSocket.test.ts",
      ],
    },
  );
});

it("parses only well-formed plans and derives the selected shard count", () => {
  const selected = {
    version: 3,
    mode: "selected",
    reason: "Affected tests: 2 changed",
    files: ["src/a.test.ts", "tests/b.test.ts"],
    shards: 2,
  };
  expect(
    testShards("fast", parseTestSelection(JSON.stringify(selected))),
  ).toEqual(["1/2", "2/2"]);
  const maxSelectedFiles = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [
      `src/feature-${String(i)}.test.ts`,
      "",
    ]),
  );
  expect(plan(Object.keys(maxSelectedFiles), maxSelectedFiles)).toMatchObject({
    mode: "selected",
    shards: 8,
  });
  const overCapFiles = {
    ...maxSelectedFiles,
    "src/feature-400.test.ts": "",
  };
  expect(plan(Object.keys(overCapFiles), overCapFiles)).toMatchObject({
    mode: "full",
    reason: "401 affected test files exceed the 400-file selection cap",
    shadowFiles: Object.keys(overCapFiles).sort(),
  });
  for (const count of [600, 601]) {
    const paths = Array.from(
      { length: count },
      (_, i) => `src/feature-${String(i)}.test.ts`,
    );
    const result = plan(
      paths,
      Object.fromEntries(paths.map((path) => [path, ""])),
    );
    expect(result.mode).toBe("full");
    expect("shadowFiles" in result).toBe(count === 600);
  }
  const unknown = { ...overCapFiles, "tests/no-owner/extra.test.ts": "" };
  expect(plan(Object.keys(unknown), unknown)).not.toHaveProperty("shadowFiles");
  const full = { version: 3, mode: "full", reason: "Shared" };
  expect(testShards("fast", parseTestSelection(full))).toHaveLength(12);
  expect(testShards("full", parseTestSelection(full))).toHaveLength(12);
  for (const value of [
    "",
    "null",
    { ...selected, version: 2 },
    { ...selected, mode: "candidate" },
    { ...selected, files: [] },
    { ...selected, files: ["src/a.ts"] },
    { ...selected, files: ["/abs/a.test.ts"] },
    { ...selected, files: ["src/a.test.ts", "src/a.test.ts"] },
    // More shards than files, or than one selection uses.
    { ...selected, shards: 3 },
    { ...selected, shards: 0 },
    {
      ...selected,
      files: Array.from({ length: 9 }, (_, i) => `src/${i}.test.ts`),
      shards: 9,
    },
    { ...full, shards: 1 },
  ])
    expect(() => parseTestSelection(value)).toThrow(
      /Invalid portable test selection plan|JSON/u,
    );
});

it("runs only a shard the plan defines", async () => {
  const environment = selectedEnvironment(
    "tests/evaluation/reasonMarker.test.ts",
    "tests/evaluation/recordPredicateGuard.test.ts",
  );
  for (const [shard, selection, diagnostic] of [
    [
      "1/2",
      environment.CI_TEST_SELECTION,
      "No selected test group 1/2 in this plan",
    ],
    [
      "1/1",
      JSON.stringify({ version: 3, mode: "full", reason: "x" }),
      "No selected test group 1/1 in this plan",
    ],
    ["1/1", "", "Unexpected end of JSON input"],
  ] as const)
    await expect(
      execute(process.execPath, [group, "selected", shard], {
        env: { ...environment, CI_TEST_SELECTION: selection },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(diagnostic),
    });
  await expect(
    execute(process.execPath, [group, "selected", "1/1", "--shard=1/2"], {
      env: environment,
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("already sharded"),
  });
});

it.each([
  ["-t", "one case"],
  ["-tX", "unused value"],
  ["--testNamePattern=one case"],
  ["--testNamePattern.only=one case"],
  ["--test-name-pattern", "one case"],
  ["--tagsFilter=long-running"],
  ["--tags-filter", "long-running"],
])("rejects a case filter in a selected shard: %j", async (...filter) => {
  await expect(
    execute(process.execPath, [group, "selected", "1/1", ...filter], {
      env: selectedEnvironment("tests/evaluation/reasonMarker.test.ts"),
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Selected test groups cannot filter cases by name or tag",
    ),
  });
});

it("runs every selected case and still permits developer name and tag filters", async () => {
  const exact = fileURLToPath(
    new URL("../../scripts/run-exact-tests.mjs", import.meta.url),
  );
  const file = "tests/evaluation/reasonMarker.test.ts";
  const root = await createTestTempDirectory("rea-selected-cases-");
  const selectedReport = join(root, "selected.json");
  await execute(
    process.execPath,
    [
      group,
      "selected",
      "1/1",
      "--reporter=json",
      `--outputFile.json=${selectedReport}`,
    ],
    { env: selectedEnvironment(file) },
  );
  const selected = JSON.parse(await readFile(selectedReport, "utf8")) as {
    numPassedTests: number;
  };
  expect(selected).toMatchObject({ numPendingTests: 0, numFailedTests: 0 });
  expect(selected.numPassedTests).toBeGreaterThan(1);

  const devReport = join(root, "developer.json");
  await execute(process.execPath, [
    exact,
    "run",
    "-t",
    "counts an unmarked slice",
    "--tagsFilter=!long-running",
    "--reporter=json",
    `--outputFile.json=${devReport}`,
    file,
  ]);
  const dev: unknown = JSON.parse(await readFile(devReport, "utf8"));
  expect(dev).toMatchObject({
    numPassedTests: 1,
    numPendingTests: selected.numPassedTests - 1,
  });
});
