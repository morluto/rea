import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it as sequentialIt } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import {
  gitRepository,
  planChanges,
} from "../../../scripts/ci/change-plan.mjs";
import {
  executeWorkflowFixture as execFileAsync,
  workflowGit as git,
} from "../../support/workflowGit.js";

async function commit(directory: string) {
  await git(directory, ["add", "."]);
  // Git names the full commit in its summary line ("[main 0123…] subject"),
  // so the case needs no separate rev-parse process.
  const summary = await git(directory, [
    "-c",
    "core.abbrev=no",
    "commit",
    "-m",
    "fix: fixture change",
  ]);
  const created = /^\[[^\]]* ([0-9a-f]{40})\]/u.exec(summary)?.[1];
  if (created === undefined)
    throw new Error(`Git did not report the fixture commit: ${summary}`);
  return created;
}

async function change(
  directory: string,
  paths: readonly string[],
  content = "Changed fixture content\n",
) {
  for (const path of paths) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return commit(directory);
}

// Every case owns its copied repository and output files, so cases run
// concurrently; each one mostly waits on Git and plan subprocesses.
const it = sequentialIt.concurrent;

let seed:
  | { readonly root: string; readonly directory: string; readonly base: string }
  | undefined;
// Owned from creation, so a failed seed setup is still removed.
let workspaceRoot: string | undefined;

beforeAll(async () => {
  const workspace = await createTestWorkspace("rea-ci-scope-seed-");
  workspaceRoot = workspace.root;
  const directory = await workspace.mkdir("repository");
  // No template: every case copies this repository, and sample hooks are
  // never run (fixture Git disables hooks).
  await git(directory, ["init", "--initial-branch=main", "--template="]);
  const base = await change(
    directory,
    ["src/provider.ts", "README.md"],
    "Initial fixture content\n",
  );
  seed = { root: workspace.root, directory, base };
});

// Case repositories live in the seed workspace and are removed with it. A
// per-case cleanup hook would bind to whichever concurrent case is current.
afterAll(async () => {
  if (workspaceRoot !== undefined) await removeTestWorkspace(workspaceRoot);
});

async function fixture() {
  const initial = seed;
  if (initial === undefined)
    throw new Error("CI scope seed was not initialized");
  const directory = await mkdtemp(join(initial.root, "case-"));
  // Copy the pristine object database, refs and index; each case owns its mutations.
  await cp(initial.directory, directory, { recursive: true });
  return { directory, base: initial.base };
}

/** Run the CI entrypoint as the workflow does, writing GITHUB_OUTPUT. */
async function runPlanScript(
  directory: string,
  base: string,
  head: string,
  event = "pull_request",
  full = false,
  skipFull = false,
) {
  const output = join(directory, "scope-output");
  await writeFile(output, "");
  const result = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("../../../scripts/ci/plan.mjs", import.meta.url))],
    {
      cwd: directory,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_EVENT_NAME: event,
        CI_FULL: String(full),
        CI_SKIP_FULL: String(skipFull),
        GITHUB_OUTPUT: output,
      },
    },
  );
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
}

/** Plan against the fixture repository's real Git history, in process. */
function classify(
  directory: string,
  base: string,
  head: string,
  event = "pull_request",
  full = false,
  skipFull = false,
): Promise<Record<string, unknown>> {
  return Promise.resolve().then(() =>
    planChanges(
      { event, full, skipFull, base, head },
      gitRepository(directory),
    ),
  );
}

const PATH_BASE = "1".repeat(40);
const PATH_HEAD = "2".repeat(40);

/**
 * Plan a commit that adds or edits only `paths`. Git's diff for such a commit
 * is exactly those paths, so these cases skip the repository; `packageJson`
 * holds package.json at the base and head when the commit edits it.
 * Deletions, renames, malformed metadata and history keep the Git fixture.
 */
function classifyCommit(
  paths: readonly string[],
  event = "pull_request",
  full = false,
  packageJson?: { readonly before: string; readonly after: string },
): Promise<Record<string, unknown>> {
  return Promise.resolve().then(() =>
    planChanges(
      { event, full, skipFull: false, base: PATH_BASE, head: PATH_HEAD },
      {
        mergeBase: (base) => base,
        isAncestor: () => true,
        changedFiles: () => paths,
        // No test reaches these synthetic paths; selection falls back to all.
        listFiles: () => [],
        readFiles: () => new Map(),
        readFile: (revision, path) => {
          if (path === "package.json" && packageJson !== undefined)
            return revision === PATH_BASE
              ? packageJson.before
              : packageJson.after;
          throw new Error(`${path} at ${revision} needs the Git fixture`);
        },
      },
    ),
  );
}

const classifyPaths = (
  paths: readonly string[],
  event?: string,
  full?: boolean,
) => classifyCommit(paths, event, full);

const classifyPackage = (before: string, after: string) =>
  classifyCommit(["package.json"], "pull_request", false, { before, after });

it.each([
  // Shared resource owners moved from src/artifacts keep their lanes.
  ["src/resources/AnalysisCleanupLease.ts", "apk_signature"],
  ["src/resources/readStableArtifact.ts", "sqlite"],
  ["src/resources/readStableArtifact.ts", "browser"],
  ["src/resources/readStableArtifact.ts", "binary_layout"],
  ["src/resources/readStableArtifact.ts", "evm"],
  ["src/resources/readStableArtifact.ts", "recorded_crash"],
  ["src/resources/readStableArtifact.ts", "web_network"],
  ["src/resources/readStableArtifact.ts", "web_source_map"],
  ["src/resources/ArtifactResourceScope.ts", "sqlite"],
  ["src/resources/ArtifactResourceScope.ts", "agentenv"],
  ["src/resources/ArtifactReader.ts", "sqlite"],
  ["src/resources/ArtifactReader.ts", "binary_layout"],
  ["src/resources/ArtifactReader.ts", "evm"],
  ["src/resources/ArtifactReader.ts", "web_network"],
  // Hopper launcher discovery moved out of config; the packaged Hopper
  // baseline still checks the launcher it selects.
  ["src/hopperPaths/HopperLauncherDiscovery.ts", "package"],
  // The pwntools input bound moved from src/native/pwntools to src/config.
  ["src/config/pwntoolsInputLimit.ts", "binary_layout"],
  ["src/config/pwntoolsInputLimit.ts", "recorded_crash"],
  ["bridge/native/rea_lldb_tracer.py", "python"],
  ["bridge/pwndbg/test_core_context.py", "python"],
  ["tests/support/analysis-efficiency/test_catalog_eval.py", "python"],
  ["scripts/run-python-tests.py", "python"],
  ["scripts/verify-browser-request.mjs", "browser"],
  ["scripts/lib/browser-request-e2e.mjs", "browser"],
  ["scripts/fixtures/browser-request-site.mjs", "browser"],
  ["scripts/lib/browser-nested-source-map-e2e.mjs", "web_source_map"],
  ["scripts/lib/browser-runtime-fixture-lifecycle.mjs", "web_source_map"],
  ["src/cliBrowserScenarioCommands.ts", "browser"],
  ["src/application/BrowserScenarioCaptureService.ts", "browser"],
  ["src/composition/browserScenario.ts", "browser"],
  ["src/cli/environmentCommands.ts", "browser"],
  ["src/application/environment/environmentBuild.ts", "browser"],
  ["src/domain/analysisView/environmentCoverageView.ts", "browser"],
  ["src/domain/analysisView/scenarioCaptureRecords.ts", "browser"],
  ["src/domain/analysisView/recordedResponseBody.ts", "browser"],
  ["src/domain/analysisView/recordedExchangeBody.ts", "browser"],
  ["src/domain/analysisView/recordedMediaType.ts", "browser"],
  ["src/domain/analysisView/webNetworkRouteTemplates.ts", "browser"],
  ["src/domain/analysisView/EnvironmentManifestAccumulator.ts", "browser"],
  ["src/domain/analysisView/EnvironmentStateAccumulator.ts", "browser"],
  ["src/domain/analysisView/WebNetworkProjectionAccumulator.ts", "browser"],
  ["src/captures/CaptureProvider.ts", "packet_capture"],
  ["tests/boundary/mcp/packetCaptureMcp.test.ts", "packet_capture"],
  ["tests/acceptance/pcapVerifier.test.ts", "packet_capture"],
  ["tests/fixtures/pcap/offlineHttpCapture.ts", "packet_capture"],
  ["scripts/verify-pcap.mjs", "packet_capture"],
  [".github/actions/ubuntu-archive/action.yml", "signal_recording"],
  ["src/signals/RecordingProvider.ts", "signal_recording"],
  ["tests/boundary/mcp/signalRecordingMcp.test.ts", "signal_recording"],
  ["src/process/LinuxResourceLimits.ts", "packet_capture"],
  ["src/process/LinuxResourceLimits.ts", "signal_recording"],
  ["scripts/ci/require-provider-tests.mjs", "packet_capture"],
  ["scripts/ci/require-provider-tests.mjs", "signal_recording"],
  // Provider ports moved from src/application keep their provider lanes.
  ["src/ports/sqlite/SqliteDatabasePort.ts", "sqlite"],
  ["src/ports/BrowserScenarioCapturePort.ts", "browser"],
  ["src/ports/WebModulePorts.ts", "browser"],
  ["src/ports/binaryDiagnostics/ElfNotesPort.ts", "binary_layout"],
  ["src/ports/binaryDiagnostics/RecordedCrashPort.ts", "recorded_crash"],
  ["src/ports/evm/EvmInterfacePort.ts", "evm"],
  ["src/ports/apkSignature/ApkSignaturePort.ts", "apk_signature"],
  ["src/ports/javascript/JavaScriptRecoveryPort.ts", "javascript_recovery"],
  ["src/ports/WebRuntimePort.ts", "web_runtime"],
  ["src/go/GoBinaryProvider.ts", "go_binary"],
  ["scripts/verify-go-binary.mjs", "go_binary"],
  ["bridge/android/ReaJadxBridge.java", "android_metadata"],
  ["src/android/JadxRelease.ts", "android_metadata"],
  [
    "tests/conformance/android/ReaJadxMetadataRegression.java",
    "android_metadata",
  ],
  ["src/ports/WebSourceLocationPorts.ts", "web_source_map"],
  ["src/ports/captures/PacketCapturePort.ts", "packet_capture"],
  ["src/ports/signals/SignalRecordingPort.ts", "signal_recording"],
])("selects %s for %s", async (path, scope) => {
  expect(await classifyPaths([path])).toMatchObject({
    [scope]: true,
  });
});

it.each(["src/domain/webCaptureDiffSchemas.ts", "src/domain/webScreenshot.ts"])(
  "selects real browser verification for %s without capture lanes",
  async (path) => {
    expect(await classifyPaths([path])).toMatchObject({
      browser: true,
      packet_capture: false,
      signal_recording: false,
    });
  },
);

it("reuses only scheduled qualification and preserves every explicit full request", async () => {
  const { directory, base } = await fixture();
  const reused = await classify(directory, base, base, "schedule", false, true);
  expect(reused.tier).toBe("reused");
  const { CI_FLAGS } = await loadScopes();
  for (const flag of CI_FLAGS) expect(reused[flag]).toBe(false);
  for (const event of ["workflow_dispatch", "pull_request", "schedule"])
    expect(
      (await classify(directory, base, base, event, true, true)).tier,
    ).toBe("full");
  expect(
    (await classify(directory, base, base, "push", false, true)).tier,
  ).toBe("fast");
});

it("keeps every translated README and authored guide on the documentation lane", async () => {
  const { directory, base } = await fixture();
  const readmes = (await readdir(new URL("../../../", import.meta.url))).filter(
    (name) => /^README(?:_.*)?\.md$/u.test(name),
  );
  const translated = (
    await readdir(new URL("../../../docs/readme/", import.meta.url))
  )
    .filter((name) => /^README_.*\.md$/u.test(name))
    .map((name) => `docs/readme/${name}`);
  expect(readmes).toContain("README.md");
  expect(translated.length).toBeGreaterThan(0);
  const head = await change(directory, [
    ...readmes,
    ...translated,
    "docs/guide.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
  ]);
  expect(await classify(directory, base, head)).toMatchObject({
    code: false,
    package: false,
    docs: true,
  });
});

it("runs documentation verification when only its published-route verifier changes", async () => {
  expect(
    await classifyPaths(["scripts/verify-documentation-routes.mjs"]),
  ).toMatchObject({
    docs: true,
  });
});

it.each(["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"])(
  "selects static checks for authored documentation code (%s) without provider lanes",
  async (extension) => {
    const plan = await classifyPaths([
      `docs/.vitepress/helpers/navigation.${extension}`,
    ]);
    const { CI_FLAGS } = await loadScopes();
    expect(plan).toMatchObject({ tier: "fast", code: true, docs: true });
    for (const flag of CI_FLAGS)
      if (flag !== "code" && flag !== "docs") expect(plan[flag]).toBe(false);
  },
);

it("retains code checks when documentation code is removed or renamed to Markdown", async () => {
  const { directory } = await fixture();
  const base = await change(directory, ["docs/.vitepress/config.ts"]);
  await git(directory, [
    "mv",
    "docs/.vitepress/config.ts",
    "docs/configuration.md",
  ]);
  const head = await commit(directory);
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    docs: true,
    runtime: false,
    package: false,
  });
});

it("selects code checks for documentation filenames containing line separators", async () => {
  expect(
    await classifyPaths(["docs/.vitepress/navigation\u2028menu.ts"]),
  ).toMatchObject({
    code: true,
    docs: true,
    runtime: false,
    package: false,
  });
});

it.each([
  "job-timings.mjs",
  "job-timings-batch.mjs",
  "test-report.mjs",
  "test-timing-reporter.mjs",
  "test-history.mjs",
])(
  "keeps portable CI reporter %s on static checks and portable tests",
  async (name) => {
    const plan = await classifyPaths([`scripts/ci/${name}`]);
    const { CI_FLAGS } = await loadScopes();
    expect(plan.code).toBe(true);
    for (const flag of CI_FLAGS)
      if (flag !== "code") expect(plan[flag]).toBe(false);
  },
);

it("preserves a provider lane when a portable CI reporter changes with provider source", async () => {
  expect(
    await classifyPaths(["scripts/ci/test-report.mjs", "src/evm/Example.ts"]),
  ).toMatchObject({
    code: true,
    evm: true,
    browser: false,
    package: false,
  });
});

it("keeps unknown CI scripts on the fast Linux baseline", async () => {
  const plan = await classifyPaths(["scripts/ci/new-qualification.mjs"]);
  const { CI_FLAGS } = await loadScopes();
  expect(plan).toMatchObject({ tier: "fast", code: true, runtime: true });
  for (const flag of CI_FLAGS)
    if (flag !== "code" && flag !== "runtime") expect(plan[flag]).toBe(false);
  expect(plan.matrix).toEqual({
    include: [{ os: "ubuntu-latest", platform: "linux", architecture: "x64" }],
  });
  const full = await classifyPaths(
    ["scripts/ci/new-qualification.mjs"],
    "pull_request",
    true,
  );
  for (const flag of CI_FLAGS) expect(full[flag]).toBe(true);
});

it("does not credit a fixture test as coverage for an unrelated shared script", async () => {
  const { directory } = await fixture();
  const module = "scripts/lib/uncovered.mjs";
  const data = "tests/fixtures/independent.txt";
  const test = "tests/boundary/filesystem/independent.test.ts";
  await mkdir(dirname(join(directory, test)), { recursive: true });
  await writeFile(join(directory, test), `readFileSync("${data}");\n`);
  const base = await change(directory, [module, data]);
  const head = await change(
    directory,
    [module, data],
    "Updated fixture content\n",
  );
  expect(await runPlanScript(directory, base, head)).toMatchObject({
    testSelection: {
      mode: "full",
      reason: `No test reaches shared script module: ${module}`,
    },
  });
});

it("selects the tests a pull request affects and runs everything when it cannot decide", async () => {
  const { directory } = await fixture();
  // The entrypoint's output file is not part of the change.
  await mkdir(join(directory, ".git", "info"), { recursive: true });
  await writeFile(join(directory, ".git", "info", "exclude"), "scope-output\n");
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  const imports = (specifier: string) =>
    `import { value } from "${specifier}";\nvoid value;\n`;
  await write("src/evm/Example.ts", "export const value = 1;\n");
  await write("src/evm/Example.test.ts", imports("./Example.js"));
  await write("src/evm/Other.ts", "export const value = 2;\n");
  await write(
    "tests/support/evmHelper.ts",
    imports("../../src/evm/Example.js"),
  );
  // Through a test-only helper, through the leaf owner, and by name.
  await write(
    "tests/composition/helped.test.ts",
    imports("../support/evmHelper.js"),
  );
  await write("tests/boundary/evm/cli.test.ts", "// spawns the built CLI\n");
  await write(
    "tests/conformance/named.test.ts",
    'readFileSync("src/evm/Example.ts");\n',
  );
  await write(
    "tests/composition/unrelated.test.ts",
    imports("../../src/provider.js"),
  );
  const base = await commit(directory);
  const head = await change(
    directory,
    ["src/evm/Example.ts"],
    "export const value = 3;\n",
  );
  const selected = [
    "src/evm/Example.test.ts",
    "tests/boundary/evm/cli.test.ts",
    "tests/composition/helped.test.ts",
    "tests/conformance/named.test.ts",
  ];
  expect(await runPlanScript(directory, base, head)).toMatchObject({
    testSelection: { version: 3, mode: "selected", files: selected, shards: 1 },
    testShards: ["1/1"],
  });
  const output = await readFile(join(directory, "scope-output"), "utf8");
  expect(output).toContain("test_mode=selected\n");
  expect(output).toContain('test_shards=["1/1"]\n');

  // ci:full, main pushes and shared or untraced inputs run the complete suite.
  expect(
    await runPlanScript(directory, base, head, "pull_request", true),
  ).toMatchObject({
    testSelection: { version: 3, mode: "full" },
    testShards: expect.arrayContaining(["12/12"]),
  });
  expect(await classify(directory, base, head, "push")).toMatchObject({
    testSelection: { mode: "full" },
    testShards: expect.arrayContaining(["12/12"]),
  });
  let previous = head;
  for (const path of [
    "src/process/Shared.ts",
    "scripts/build-something.mjs",
    "tests/fixtures/data.bin",
  ]) {
    const parent = previous;
    previous = await change(directory, [path]);
    expect(await classify(directory, parent, previous)).toMatchObject({
      testSelection: { mode: "full", reason: expect.stringContaining(path) },
    });
  }
  // A leaf owner's boundary tests cover its other modules.
  const unreached = await change(
    directory,
    ["src/evm/Other.ts"],
    "export const value = 4;\n",
  );
  expect(await classify(directory, previous, unreached)).toMatchObject({
    testSelection: { mode: "selected" },
  });
  const isolated = await change(directory, ["src/unowned/Lonely.ts"]);
  expect(await classify(directory, unreached, isolated)).toMatchObject({
    testSelection: {
      mode: "full",
      reason: "No test imports, names or sits beside a changed path",
    },
  });
  // Above the cap, selection gives way to the complete suite.
  const many = Array.from(
    { length: 401 },
    (_, index) => `tests/composition/many${String(index)}.test.ts`,
  );
  const wide = await change(directory, many);
  expect(await classify(directory, isolated, wide)).toMatchObject({
    testSelection: {
      mode: "full",
      reason: "401 affected test files exceed the 400-file selection cap",
    },
  });
  const capped = await change(directory, many.slice(0, 101), "// edited\n");
  expect(await classify(directory, wide, capped)).toMatchObject({
    testSelection: { mode: "selected" },
    testShards: ["1/3", "2/3", "3/3"],
  });
});

it("routes license inventories to docs checks and keeps blame-ignore edits formatting-only", async () => {
  expect(await classifyPaths([".git-blame-ignore-revs"])).toMatchObject({
    code: false,
    docs: false,
    runtime: false,
    package: false,
  });
  expect(await classifyPaths(["licenses/npm-dependencies.txt"])).toMatchObject({
    code: true,
    docs: true,
    runtime: false,
    package: false,
  });
  expect(await classifyPaths(["THIRD_PARTY_NOTICES.md"])).toMatchObject({
    code: true,
    docs: true,
    runtime: false,
    package: false,
  });
  expect(await classifyPaths(["LICENSE"])).toMatchObject({
    code: true,
    docs: true,
    runtime: false,
    package: false,
  });
  for (const staticOnly of [
    "scripts/lib/module-layers.baseline.json",
    "scripts/verify/architecture-guards.mjs",
    "scripts/verify/baselines/raw-buffer-read.json",
    "tsconfig.scripts.json",
  ]) {
    expect(await classifyPaths([staticOnly]), staticOnly).toMatchObject({
      code: true,
      docs: false,
      runtime: false,
      package: false,
    });
  }
  for (const docsAndCode of [
    "scripts/check-doc-facts.mjs",
    "scripts/lib/product-catalog.mjs",
  ]) {
    expect(await classifyPaths([docsAndCode]), docsAndCode).toMatchObject({
      code: true,
      docs: true,
      runtime: false,
      package: false,
    });
  }
  expect(
    await classifyPaths([
      ".cursor-plugin/skills/reverse-engineer-anything/SKILL.md",
    ]),
  ).toMatchObject({
    docs: true,
    runtime: true,
    package: false,
  });
});

it("passes the workflow environment through the entrypoint unchanged", async () => {
  const { directory, base } = await fixture();
  const head = await change(directory, ["src/evm/Example.ts"]);
  const { CI_FLAGS } = await loadScopes();
  // Fast and reused plans exercise BASE_SHA/HEAD_SHA and CI_SKIP_FULL; the
  // entrypoint must answer exactly as the in-process planner does.
  for (const [event, skipFull, tier] of [
    ["pull_request", false, "fast"],
    ["push", false, "fast"],
    ["schedule", true, "reused"],
  ] as const) {
    const expected = await classify(
      directory,
      base,
      head,
      event,
      false,
      skipFull,
    );
    expect(expected.tier).toBe(tier);
    expect(
      await runPlanScript(directory, base, head, event, false, skipFull),
    ).toEqual(expected);
    const output = await readFile(join(directory, "scope-output"), "utf8");
    for (const flag of CI_FLAGS)
      expect(output).toContain(`${flag}=${String(expected[flag])}\n`);
    expect(output).toContain(`tier=${tier}\n`);
  }
});

it("does not charge a documentation PR for unrelated implementation updates on main", async () => {
  const { directory, base } = await fixture();
  await git(directory, ["switch", "-c", "docs/change"]);
  const head = await change(directory, ["docs/readme/README_zh-TW.md"]);
  await git(directory, ["switch", "main"]);
  const advancedBase = await change(directory, ["src/anotherProvider.ts"]);
  expect(advancedBase).not.toBe(base);
  expect(await classify(directory, advancedBase, head)).toMatchObject({
    code: false,
    package: false,
  });
});

it.each([
  "src/gdb/GdbSessionManager.ts",
  "src/rizin/RizinDebugSessionManager.ts",
  "src/cutter/CutterBridgeClient.ts",
  "src/objdump/ObjdumpCommand.ts",
  "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
  "tests/boundary/providers/GdbCommandQueue.test.ts",
  "tests/boundary/providers/RizinDebugSessionCoverage.part3.test.ts",
  "tests/boundary/providers/GdbSessionReviewRegressions.test.ts",
  "tests/boundary/providers/gdbTestHelpers.ts",
  "tests/boundary/providers/RizinDebugSessionReviewRegressions.test.ts",
  "tests/boundary/mcp/gdbCancellationMcp.test.ts",
  "tests/boundary/mcp/rizinDebuggerCancellationMcp.test.ts",
  "tests/boundary/mcp/rizinPendingOutput.test.ts",
  "tests/composition/reverseEngineeringAdmission.test.ts",
  "tests/support/reverseEngineeringMcpHarness.ts",
  "tests/support/reverseEngineeringCompositionEdgeCases.ts",
  "tests/support/reverseEngineeringCompositionFixtures.ts",
  "tests/support/reverseEngineeringService.ts",
  "tests/support/ownedRizinCommandEvidenceTests.ts",
  "tests/support/reverseDebuggerMcpTestHelpers.ts",
  "tests/boundary/cli/debuggerOneShotExit.test.ts",
  "tests/boundary/cli/gdbStartupCleanupCli.test.ts",
  "vitest.reverse-tools.config.ts",
  "vitest.reverse-tools-semantics.config.ts",
  "stryker.config.mjs",
  "stryker.semantics.config.mjs",
  "tsconfig.reverse-tools-mutation.json",
  "scripts/prepare-reverse-tools-mutation.mjs",
  "scripts/lib/reverse-tools-mutation-targets.mjs",
])(
  "selects the reverse-tool coverage and mutation gate for %s",
  async (path) => {
    expect(await classifyPaths([path])).toMatchObject({
      code: true,
      reverse_tools: true,
    });
  },
);

const reverseToolsVitestConfig = await readFile(
  new URL("../../../vitest.reverse-tools.config.ts", import.meta.url),
  "utf8",
);
const reverseToolsVitestInputs = [
  ...reverseToolsVitestConfig.matchAll(/"((?:\.\/)?(?:src|tests)\/[^"]+)"/gu),
].flatMap((match) =>
  match[1] === undefined ? [] : [match[1].replace(/^\.\//u, "")],
);
const reverseToolsMutationConfig = JSON.parse(
  await readFile(
    new URL("../../../tsconfig.reverse-tools-mutation.json", import.meta.url),
    "utf8",
  ),
) as { include: string[] };
const reverseToolsInputs = [
  ...new Set([
    ...reverseToolsVitestInputs,
    ...reverseToolsMutationConfig.include.map((path) =>
      path.replace(/^\.\//u, ""),
    ),
  ]),
];

it.each(reverseToolsInputs)(
  "selects the reverse-tool quality gate for configured input %s",
  async (path) => {
    expect(await classifyPaths([path])).toMatchObject({
      code: true,
      reverse_tools: true,
    });
  },
);

it.each([
  "src/README.md",
  "README.md.ts",
  "bridge/ghidra/provider.py",
  "tests/fixture.test.ts",
  ".github/workflows/ci.yml",
  "unknown-file",
])(
  "retains complete checks when documentation is mixed with %s",
  async (path) => {
    expect(await classifyPaths(["README.md", path])).toMatchObject({
      code: true,
    });
  },
);

it("retains complete checks when implementation is renamed into documentation", async () => {
  const { directory, base } = await fixture();
  await mkdir(join(directory, "docs"));
  await rename(
    join(directory, "src/provider.ts"),
    join(directory, "docs/provider.md"),
  );
  const head = await commit(directory);
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    runtime: true,
  });
});

it("keeps main pushes scoped when a successful ancestor baseline is available", async () => {
  expect(
    await classifyPaths(["docs/readme/README_ja.md"], "push"),
  ).toMatchObject({
    tier: "fast",
    code: false,
    package: false,
    docs: true,
    matrix: {
      include: [
        { os: "ubuntu-latest", platform: "linux", architecture: "x64" },
      ],
    },
  });
});

it("includes changes from earlier cancelled pushes since the last successful baseline", async () => {
  const { directory, base } = await fixture();
  await change(directory, ["src/evm/client.ts"]);
  const head = await change(directory, ["README.md"]);
  expect(await classify(directory, base, head, "push")).toMatchObject({
    tier: "fast",
    code: true,
    evm: true,
    runtime: true,
    package: false,
  });
});

it.each(["", "not-a-commit"])(
  "fails closed to the fast Linux baseline for a missing or invalid push baseline (%s)",
  async (base) => {
    const { directory } = await fixture();
    const head = await change(directory, ["README.md"]);
    const plan = await classify(directory, base, head, "push");
    expect(plan).toMatchObject({
      tier: "fast",
      code: true,
      runtime: true,
      package: false,
      evm: false,
      browser: false,
      reasons: expect.arrayContaining([expect.stringContaining("baseline")]),
    });
    const { CI_FLAGS } = await loadScopes();
    for (const flag of CI_FLAGS)
      if (flag !== "code" && flag !== "runtime") expect(plan[flag]).toBe(false);
    expect(plan.matrix).toEqual({
      include: [
        { os: "ubuntu-latest", platform: "linux", architecture: "x64" },
      ],
    });
  },
);

it("selects a completed CI ancestor rather than a foreign or non-terminal run", async ({
  skip,
}) => {
  skip(process.platform === "win32", "the fake gh is a POSIX shell script");
  const { directory, base } = await fixture();
  const foreignBase = await change(directory, ["README.md"]);
  const head = await change(directory, ["src/evm/client.ts"]);
  const bin = join(directory, "fake-bin");
  await mkdir(bin);
  const gh = join(bin, "gh");
  await writeFile(gh, '#!/bin/sh\ncat "$GH_FIXTURE_RESPONSE"\n');
  await chmod(gh, 0o755);
  const response = join(directory, "runs.json");
  await writeFile(
    response,
    JSON.stringify({
      workflow_runs: [
        {
          status: "completed",
          path: ".github/workflows/ci.yml@refs/heads/main",
          event: "push",
          conclusion: "success",
          head_branch: "main",
          head_repository: { full_name: "untrusted/fork" },
          head_sha: foreignBase,
        },
        {
          status: "in_progress",
          path: ".github/workflows/ci.yml@refs/heads/main",
          event: "push",
          conclusion: "success",
          head_branch: "main",
          head_repository: { full_name: "owner/repo" },
          head_sha: foreignBase,
        },
        {
          status: "completed",
          path: ".github/workflows/release.yml@refs/heads/main",
          event: "push",
          conclusion: "success",
          head_branch: "main",
          head_repository: { full_name: "owner/repo" },
          head_sha: foreignBase,
        },
        {
          status: "completed",
          path: ".github/workflows/ci.yml@refs/heads/main",
          event: "push",
          conclusion: "success",
          head_branch: "main",
          head_repository: { full_name: "owner/repo" },
          head_sha: base,
        },
      ],
    }),
  );
  const output = join(directory, "baseline-output");
  const result = await execFileAsync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../scripts/ci/baseline.mjs", import.meta.url),
      ),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_FIXTURE_RESPONSE: response,
        CI_REPOSITORY: "owner/repo",
        CI_DEFAULT_BRANCH: "main",
        HEAD_SHA: head,
        GITHUB_OUTPUT: output,
      },
    },
  );
  expect(JSON.parse(result.stdout)).toEqual({ base, reason: "" });
  expect(await readFile(output, "utf8")).toBe(`base=${base}\nreason=\n`);
});

it("returns an empty baseline when GitHub lookup fails", async ({ skip }) => {
  skip(process.platform === "win32", "the fake gh is a POSIX shell script");
  const { directory, base } = await fixture();
  const head = await change(directory, ["src/evm/client.ts"]);
  const bin = join(directory, "fake-bin");
  await mkdir(bin);
  const gh = join(bin, "gh");
  await writeFile(gh, "#!/bin/sh\nexit 1\n");
  await chmod(gh, 0o755);
  const result = await execFileAsync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../scripts/ci/baseline.mjs", import.meta.url),
      ),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CI_REPOSITORY: "owner/repo",
        CI_DEFAULT_BRANCH: "main",
        HEAD_SHA: head,
      },
    },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    base: "",
    reason: expect.stringContaining("Could not read"),
  });
  expect(head).not.toBe(base);
});

it("fails closed when the successful push baseline is not an ancestor", async () => {
  const { directory, base } = await fixture();
  await git(directory, ["switch", "-c", "unrelated"]);
  const unrelated = await change(directory, ["other.txt"]);
  await git(directory, ["switch", "main"]);
  const head = await change(directory, ["README.md"]);
  expect(await classify(directory, unrelated, head, "push")).toMatchObject({
    tier: "fast",
    code: true,
    runtime: true,
    package: false,
    evm: false,
    browser: false,
  });
  expect(head).not.toBe(base);
});

it("fails classification rather than treating an invalid Git comparison as a scope", async () => {
  const { directory, base } = await fixture();
  await expect(
    runPlanScript(directory, "missing-ref", base),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readFile(join(directory, "scope-output"), "utf8")).toBe("");
});

it("retains native Inspector verification on every documented package host", async () => {
  const stepSchema = z.object({
    run: z.string().optional(),
    if: z.string().optional(),
  });
  const steps = z.array(stepSchema);
  const workflow = z
    .object({
      jobs: z.object({
        "package-e2e": z.object({
          steps,
        }),
        "windows-curated": z.object({ steps }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  const packageLane = workflow.jobs["package-e2e"];
  const packageInspector = stepSchema.parse(
    packageLane.steps.find((step) => step.run === "npm run verify:inspector"),
  );
  expect(packageInspector.if).toBeUndefined();
  expect(
    (await classify((await fixture()).directory, "", "", "workflow_dispatch"))
      .matrix,
  ).toEqual({
    include: [
      { os: "ubuntu-latest", platform: "linux", architecture: "x64" },
      { os: "ubuntu-24.04-arm", platform: "linux", architecture: "arm64" },
      { os: "macos-15", platform: "darwin", architecture: "arm64" },
      { os: "macos-15-intel", platform: "darwin", architecture: "x64" },
    ],
  });
  const windowsSteps = workflow.jobs["windows-curated"].steps;
  const windowsBuild = windowsSteps.findIndex(
    (step) => step.run === "npm run build:cached",
  );
  expect(windowsBuild).toBeGreaterThanOrEqual(0);
  expect(windowsSteps[windowsBuild]?.if).toBeUndefined();
  for (const [verifier, condition] of [
    ["node scripts/verify/inspector/runtime-observation.mjs", undefined],
    ["node scripts/verify-windows-package.mjs", "matrix.suite == 'package'"],
  ] as const) {
    const step = windowsSteps.findIndex(({ run }) => run === verifier);
    expect(step).toBeGreaterThan(windowsBuild);
    expect(windowsSteps[step]?.if).toBe(condition);
  }
});

it.each([
  [
    "src/evm/client.ts",
    {
      code: true,
      runtime: true,
      evm: true,
      browser: false,
      package: false,
      sqlite: false,
    },
  ],
  [
    "scripts/verify-solidity-metadata.mjs",
    { code: true, evm: true, browser: false, package: false },
  ],
  [
    "src/browser/execution/evaluate.ts",
    {
      code: true,
      runtime: true,
      browser: true,
      web_runtime: true,
      evm: false,
      package: false,
    },
  ],
  [
    "tests/module/example.test.ts",
    { code: true, runtime: false, browser: false, package: false },
  ],
  // The darwin package baseline is the CI run of packaged Hopper commands
  // against the fake bridge and the reply contracts.
  [
    "tests/process-global/curatedWindowsLane.test.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "tests/fixtures/fakeHopper.mjs",
    { code: true, runtime: true, package: true },
  ],
  [
    "tests/fixtures/fakeHopperReplies.mjs",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/hopper/HopperReplyContracts.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/domain/native/nativeSegments.ts",
    { code: true, runtime: true, package: true },
  ],
  // Schemas the contracts import transitively.
  [
    "src/domain/native/functionBody.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/domain/native/nativeSymbol.ts",
    { code: true, runtime: true, package: true },
  ],
  ["src/domain/native/functionBody.test.ts", { code: true, package: false }],
  ["scripts/lib/release-proposal.mjs", { code: true, package: true }],
  ["scripts/lib/release-proposal.d.mts", { code: true, package: true }],
  ["scripts/lib/release-pull-request.mjs", { code: true, package: true }],
  ["patches/release-please+17.3.0.patch", { code: true, package: true }],
  [
    "tests/boundary/filesystem/releaseProposal.test.ts",
    { code: true, package: true },
  ],
  ["website/src/index.ts", { code: false, website: true, package: false }],
  [
    "website/public/examples/notes-electron/preload.js",
    { code: true, website: true, package: false },
  ],
  [
    "website/public/index.html",
    { code: false, docs: true, website: true, package: false },
  ],
  [
    "website/locales/zh-CN/messages.po",
    { code: false, website: true, package: false },
  ],
  ["scripts/website_i18n.py", { code: false, website: true, package: false }],
  ["src/domain/skillManifest.ts", { website: true }],
  [
    "docs/readme/README_ja.md",
    { code: false, docs: true, website: true, package: false },
  ],
  [
    ".github/workflows/website-pages.yml",
    { code: false, website: true, package: false },
  ],
  [
    "src/process/ProviderProcess.ts",
    {
      code: true,
      runtime: true,
      package: false,
      evm: false,
      browser: false,
      sqlite: false,
    },
  ],
  [
    "package-lock.json",
    {
      code: true,
      runtime: true,
      website: true,
      package: true,
      evm: false,
      browser: false,
    },
  ],
  [
    ".github/workflows/real-evm-interface.yml",
    { code: false, evm: true, browser: false, package: false },
  ],
  [
    "unknown-input",
    {
      code: true,
      runtime: true,
      package: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "src/application/Example.ts",
    {
      code: true,
      runtime: true,
      package: false,
      apple: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "scripts/verify-ghidra-bridge-sources.mjs",
    { code: true, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "scripts/verify-ghidra-loader-relocation.mjs",
    { code: true, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "scripts/verify-ghidra-prototype-conflicts.mjs",
    { code: true, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/ReaLoaderRelocationProbe.java",
    { code: true, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/loader-relocation-provider.c",
    { code: true, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "src/ghidra/GhidraBridgeSources.ts",
    { code: true, ghidra_bridge: true, runtime: true, package: true },
  ],
  [
    "src/ghidra/GhidraJavaProperties.ts",
    { code: true, ghidra_bridge: true, runtime: true, package: false },
  ],
  [
    "src/ghidra/GhidraReleasePolicy.ts",
    { code: true, ghidra_bridge: true, runtime: true },
  ],
  [
    ".github/workflows/ghidra-bridge-sources.yml",
    { code: false, ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/ReaInstructionContextProbe.java",
    { ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/ReaComputedCallCoverageProbe.java",
    { ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/ReaDecodeProbe.java",
    { ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/ReaPrototypeConflictProbe.java",
    { ghidra_bridge: true, runtime: false, package: false },
  ],
  [
    "bridge/ghidra/Example.java",
    {
      code: true,
      runtime: true,
      ghidra_bridge: true,
      package: false,
      apple: false,
    },
  ],
  [
    "src/native/AppleExample.ts",
    { code: true, runtime: true, apple: true, package: false, evm: false },
  ],
  [
    "src/artifacts/NativeDmgArtifactReader.ts",
    { code: true, runtime: true, apple: true, package: false, evm: false },
  ],
  [
    "tests/acceptance/artifactDmgAttachmentRecoveryCli.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/process-global/dmgCancellationReason.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "scripts/verify/apple/example.mjs",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "src/process/WindowsExecutable.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/process/WindowsExecutable.test.ts",
    { code: true, runtime: true, package: true },
  ],
  ["src/adb/AdbConfiguration.ts", { code: true, runtime: true, package: true }],
  [
    "src/application/binaryDiagnostics/ByteEntropyService.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "tests/acceptance/byteEntropyWindowsIdentity.test.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/apktool/ApktoolConfiguration.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "src/application/UpdateCommandRunner.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    "tests/boundary/process/windowsExecutableSelection.test.ts",
    { code: true, runtime: true, package: true },
  ],
  ["src/hopper/BridgeLauncher.ts", { code: true, apple: true }],
  ["src/hopper/HopperErrors.ts", { code: true, apple: true }],
  [
    "tests/boundary/providers/hopper/hopperMacLaunchArguments.test.ts",
    { code: true, apple: true },
  ],
  [
    "tests/boundary/providers/hopper/hopperClient.helperFailure.test.ts",
    { code: true, apple: true },
  ],
  [
    "src/windows/Example.ts",
    { code: true, runtime: true, package: true, apple: false, evm: false },
  ],
  [
    "src/domain/windowsNativeArtifact.ts",
    { code: true, runtime: true, package: true },
  ],
  [
    ".github/actions/windows-cross-compiler/action.yml",
    { code: true, runtime: true, package: true },
  ],
  [
    ".github/actions/ubuntu-archive/action.yml",
    { code: true, runtime: true, package: true, binary_layout: true },
  ],
  [
    ".github/actions/ubuntu-archive/action.yaml",
    {
      code: true,
      runtime: true,
      package: true,
      binary_layout: true,
      signal_recording: true,
      workflows: true,
    },
  ],
  [
    ".github/actions/host-apt-packages/action.yml",
    {
      code: true,
      runtime: true,
      package: true,
      binary_layout: true,
      signal_recording: true,
      recorded_crash: false,
      workflows: true,
    },
  ],
  [
    ".github/actions/host-apt-packages/action.yaml",
    {
      code: true,
      runtime: true,
      package: true,
      binary_layout: true,
      signal_recording: true,
      recorded_crash: false,
      workflows: true,
    },
  ],
  ["src/domain/peCoffHeader.ts", { code: true, runtime: true, package: true }],
  ["src/domain/dosMz.ts", { code: true, runtime: true, package: true }],
  [
    "scripts/lib/verifier-source-loader.mjs",
    { code: true, runtime: true, package: true },
  ],
  [
    "tests/boundary/process/windowsNativeArtifactVerifier.test.ts",
    { code: true, package: true },
  ],
  [
    "scripts/lib/windows-native-inspection-workspace.mjs",
    { code: true, package: true },
  ],
  [
    "tests/boundary/process/windowsNativeInspectionWorkspace.test.ts",
    { code: true, package: true },
  ],
  [
    "src/domain/javascript/javascriptRuntimeStaticCandidates.ts",
    { code: true, runtime: true, package: true, javascript_recovery: true },
  ],
  ["install.sh", { code: true, runtime: true, package: true, evm: false }],
  [
    ".agents/skills/reverse-engineer-anything/SKILL.md",
    {
      code: true,
      runtime: true,
      docs: true,
      website: true,
      package: false,
      evm: false,
    },
  ],
  [
    "scripts/verify-real-ghidra.mjs",
    { code: true, runtime: false, package: false, apple: false, evm: false },
  ],
  [
    "scripts/verify-claude-client.mjs",
    { code: true, runtime: false, package: false, browser: false },
  ],
  [
    "tests/boundary/process/darwinProcessRunTokenReader.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/cli/nativePlistCli.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/process/nativeUiVerifierLane.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/providers/native/nativeUiOffscreenWindow.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/conformance/native/ui-offscreen.swift",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "src/artifacts/InesArtifactReader.ts",
    { code: true, apple: true, package: false, runtime: true },
  ],
  [
    "src/domain/inesContainer.ts",
    { code: true, apple: true, docs: true, package: false, runtime: true },
  ],
  [
    "tests/fixtures/ines.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/acceptance/inesContainer.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/filesystem/inesArtifact.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/filesystem/inesCancellation.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "scripts/ci/qualified-package-envelope.mjs",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "scripts/ci/prepare-npm-publication.mjs",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "scripts/ci/npm-release-state.mjs",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "tests/boundary/filesystem/windowsNpxRegistration.test.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "tests/boundary/filesystem/clientConfigurationEnvironment.test.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "tests/boundary/filesystem/clientConfigurationLayeredEnvironment.test.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "tests/acceptance/setup/registrationRuntimeEnvironmentCli.test.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientRegistrationEnvironment.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientRegistrationStatus.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientRegistrationIdentity.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientConfigurationDocument.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientConfigurationFiles.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientConfigurationPublication.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/ClientConfigurationCleanup.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/DshCordisPatch.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/application/DshCordisYaml.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/desktop/AgentEnvBridgeSources.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "scripts/verify-packed-bridge.mjs",
    {
      code: true,
      package: true,
      runtime: true,
      apple: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "scripts/verify-packed-bridge.d.mts",
    {
      code: true,
      package: true,
      runtime: true,
      apple: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "tests/boundary/process/packedBridgeVerification.test.ts",
    {
      code: true,
      package: true,
      runtime: true,
      apple: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "src/process/ProcessOwnership.test.ts",
    { code: true, package: true, apple: false, evm: false, browser: false },
  ],
  [
    "src/sqlite/SqliteDatabaseProvider.ts",
    { code: true, sqlite: true, runtime: true, package: false },
  ],
  [
    "src/application/sqlite/SqliteDatabaseService.test.ts",
    { code: true, sqlite: true, runtime: false },
  ],
  [
    "tests/boundary/sqlite/sqliteDatabaseProvider.test.ts",
    { code: true, sqlite: true, runtime: false },
  ],
  [
    "tests/fixtures/sqlite/database.ts",
    { code: true, sqlite: true, runtime: false },
  ],
  ["tests/acceptance/sqliteDatabaseCli.test.ts", { code: true, sqlite: true }],
  [
    "tests/boundary/mcp/serverLifecycleMcp.test.ts",
    { code: true, sqlite: true },
  ],
  [
    "src/process/OwnedCommand.ts",
    {
      code: true,
      sqlite: false,
      runtime: true,
      package: false,
      browser: false,
    },
  ],
  // One lane names it; others reach it only through `src/process/**`.
  [
    "src/process/RegularFileRead.ts",
    {
      code: true,
      runtime: true,
      agentenv: true,
      javascript_recovery: false,
      recorded_crash: false,
      web_source_map: false,
      package: false,
    },
  ],
  [
    "src/process/ownedDebuggerSession.ts",
    {
      code: true,
      runtime: true,
      reverse_tools: true,
      javascript_recovery: false,
      package: false,
    },
  ],
  [
    "src/server/createServer.ts",
    {
      code: true,
      sqlite: false,
      runtime: true,
      package: false,
      browser: false,
    },
  ],
  [
    "src/contracts/toolContracts.ts",
    {
      code: true,
      sqlite: false,
      runtime: true,
      package: false,
      browser: false,
    },
  ],
  [
    "src/domain/analysisErrorProjection.ts",
    { code: true, sqlite: true, runtime: true },
  ],
  [
    "src/application/environment/environmentExport.ts",
    {
      code: true,
      runtime: true,
      agentenv: true,
      browser: true,
      package: false,
    },
  ],
  [
    "scripts/verify-agentenv-environment.mjs",
    { code: true, agentenv: true, runtime: false, package: false },
  ],
  [
    "src/domain/analysisView/scenarioCaptureRecords.ts",
    { code: true, agentenv: true, runtime: true, package: false },
  ],
  [
    "src/domain/analysisView/WebNetworkProjectionAccumulator.ts",
    { code: true, agentenv: true, runtime: true, package: false },
  ],
  [
    "src/domain/analysisView/analysisViewDataAdmission.ts",
    { code: true, agentenv: true, runtime: true, package: false },
  ],
  [
    "src/application/OwnedJsonInput.ts",
    { code: true, agentenv: true, runtime: true, package: false },
  ],
  [
    "src/resources/SafeOutputTree.ts",
    { code: true, agentenv: true, runtime: true },
  ],
  [
    "src/cli/cliJsonInput.ts",
    { code: true, agentenv: true, runtime: true, package: false },
  ],
  [
    "tests/boundary/process/agentenvVerifierIdentity.test.ts",
    { code: true, agentenv: false, runtime: false, package: false },
  ],
  [
    ".github/workflows/real-agentenv.yml",
    { code: false, agentenv: true, workflows: true, package: false },
  ],
  [
    "src/domain/javascript/example.ts",
    { code: true, sqlite: false, ghidra_bridge: false, agentenv: false },
  ],
])("selects the appropriate lanes for %s", async (path, expected) => {
  expect(await classifyPaths([path])).toMatchObject(expected);
});

it("scopes package script edits while retaining broad dependency checks", async () => {
  const { directory } = await fixture();
  const before = {
    name: "fixture",
    scripts: { "verify:evm": "node scripts/verify-evm-interface.mjs" },
  };
  const base = await change(
    directory,
    ["package.json"],
    JSON.stringify(before),
  );
  const after = {
    ...before,
    scripts: {
      "verify:evm": "node scripts/verify-evm-interface.mjs --verbose",
    },
  };
  const head = await change(directory, ["package.json"], JSON.stringify(after));
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    evm: true,
    browser: false,
    package: false,
  });
  const dependency = await change(
    directory,
    ["package.json"],
    JSON.stringify({ ...after, dependencies: { example: "1.0.0" } }),
  );
  expect(await classify(directory, head, dependency)).toMatchObject({
    code: true,
    runtime: true,
    browser: false,
    package: false,
    evm: false,
  });
});

it.each(["test:sqlite", "test:sqlite:run"])(
  "routes %s script changes to the SQLite runtime matrix",
  async (script) => {
    expect(
      await classifyPackage(
        JSON.stringify({ scripts: { [script]: "vitest run" } }),
        JSON.stringify({
          scripts: { [script]: "vitest run --reporter=default" },
        }),
      ),
    ).toMatchObject({
      code: true,
      sqlite: true,
      evm: false,
      package: false,
    });
  },
);

it("keeps unrelated test script changes off the SQLite runtime matrix", async () => {
  expect(
    await classifyPackage(
      JSON.stringify({ scripts: { "test:domain": "vitest run src/domain" } }),
      JSON.stringify({
        scripts: { "test:domain": "vitest run src/domain --reporter=default" },
      }),
    ),
  ).toMatchObject({
    code: true,
    sqlite: false,
    evm: false,
  });
});

it.each([
  "src/apkSignature/ApkSignatureProvider.ts",
  "src/domain/apkSignature/apkSignatureSchemes.ts",
  "scripts/verify-apk-signature.mjs",
])("selects the real APK signing lane for %s", async (path) => {
  expect(await classifyPaths([path])).toMatchObject({
    apk_signature: true,
  });
});

it.each([
  ["browser", "real-browser"],
  ["binary_layout", "real-binary-layout"],
  ["evm", "real-evm-interface"],
  ["apk_signature", "real-apk-signature"],
  ["javascript_recovery", "real-javascript-recovery"],
  ["recorded_crash", "real-recorded-crash"],
  ["web_network", "real-web-network-captures"],
  ["web_runtime", "real-web-runtime"],
  ["web_source_map", "real-web-source-map"],
  ["agentenv", "real-agentenv"],
  ["nativeaot", "nativeaot-fixtures"],
  ["ghidra_bridge", "ghidra-bridge-sources"],
  ["website", "website-check"],
])(
  "routes %s through the selector without a duplicate PR trigger",
  async (scope, name) => {
    const workflow = z
      .object({
        on: z
          .object({ workflow_call: z.object({}).passthrough().nullable() })
          .passthrough(),
      })
      .parse(
        parse(
          await readFile(
            new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
            "utf8",
          ),
        ),
      );
    expect(workflow.on).not.toHaveProperty("pull_request");
    const ci = z
      .object({
        jobs: z.record(
          z.string(),
          z.object({
            uses: z.string().optional(),
            if: z.string().optional(),
          }),
        ),
      })
      .parse(
        parse(
          await readFile(
            new URL("../../../.github/workflows/ci.yml", import.meta.url),
            "utf8",
          ),
        ),
      );
    expect(ci.jobs[scope]).toMatchObject({
      uses: `./.github/workflows/${name}.yml`,
      if: `needs.changes.outputs.${scope} == 'true'`,
    });
  },
);

it.each(["evm", "browser"])(
  "rejects skipped selected %s work while allowing unselected lanes to skip",
  async (scope) => {
    const command = fileURLToPath(
      new URL("../../../scripts/ci/required.mjs", import.meta.url),
    );
    const { CI_FLAGS } = await loadScopes();
    const jobs = {
      changes: {
        result: "success",
        outputs: {
          ...Object.fromEntries(CI_FLAGS.map((flag) => [flag, "false"])),
          tier: "fast",
          test_mode: "full",
          [scope]: "true",
        },
      },
      static: { result: "success" },
      test: { result: "success" },
      evm: { result: "skipped" },
      browser: { result: "skipped" },
    };
    const run = (result: string) =>
      execFileAsync(process.execPath, [command], {
        env: {
          ...process.env,
          CI_JOBS: JSON.stringify({ ...jobs, [scope]: { result } }),
        },
      });
    await expect(run("success")).resolves.toMatchObject({ stderr: "" });
    for (const result of ["failure", "cancelled", "skipped"]) {
      await expect(run(result)).rejects.toMatchObject({ code: 1 });
    }
  },
);

it.each([
  [
    ".github/workflows/mutation.yml",
    { workflows: true, code: true, reverse_tools: true, package: false },
  ],
  [
    ".github/workflows/sqlite-runtime.yml",
    { workflows: true, code: true, package: false, website: false },
  ],
  [
    ".github/workflows/real-termux.yml",
    { workflows: true, code: false, package: false, website: false },
  ],
  [
    ".github/actions/npm-cache/action.yml",
    { workflows: true, code: true, runtime: true, package: false },
  ],
  [
    ".github/actions/example/nested/action.yaml",
    { workflows: true, code: true, runtime: true, package: false },
  ],
  [
    ".github/actions/publish-mcp/registry-state.mjs",
    { workflows: false, code: true, runtime: true, package: true },
  ],
  [
    ".github/actionlint.yml",
    { workflows: true, code: false, runtime: false, package: false },
  ],
  [
    "src/domain/javascript/example.test.ts",
    { code: true, runtime: false, javascript_recovery: false, package: false },
  ],
  [
    "src/process/capture/example.test.ts",
    { code: true, runtime: false, browser: false, package: false },
  ],
  [
    ".nvmrc",
    {
      code: true,
      runtime: true,
      package: true,
      browser: false,
      evm: false,
      sqlite: false,
    },
  ],
  [
    "tsconfig.build.json",
    {
      code: true,
      runtime: true,
      package: true,
      browser: false,
      evm: false,
    },
  ],
  ["docs/.vitepress/config.ts", { code: true, docs: true, package: false }],
  [
    "docs/package.json",
    { code: true, docs: true, runtime: false, package: false },
  ],
  [
    "docs/.vitepress/package.json",
    { code: true, docs: true, runtime: false, package: false },
  ],
  ["package-lock.json", { code: true, docs: true, runtime: true }],
  [
    "scripts/generate-third-party-inventory.mjs",
    { code: true, docs: true, runtime: false },
  ],
  ["docs/data.json", { code: false, docs: true, package: false }],
  ["CHANGELOG.md", { code: false, docs: true, package: false }],
  ["SECURITY.md", { code: false, docs: true, package: false }],
  [".github/pull_request_template.md", { code: false, docs: true }],
  [
    ".github/ISSUE_TEMPLATE/bug.yml",
    { code: false, docs: true, workflows: false },
  ],
  ["native/windows/README.md", { code: false, docs: true, package: false }],
  [
    "src/contracts/evm/tools.ts",
    { code: true, docs: true, evm: true, package: false },
  ],
  [
    "scripts/unknown-website-helper.mjs",
    { code: true, runtime: true, package: false, browser: false },
  ],
  [
    ".github/workflows/release.yml",
    { workflows: true, code: true, package: false, website: false },
  ],
  [
    ".github/workflows/codeql.yml",
    { workflows: true, code: true, runtime: false, package: false },
  ],
  [
    ".github/codeql/production.yml",
    { workflows: true, code: true, runtime: false, package: false },
  ],
  [
    ".github/workflows/real-ghidra-windows.yml",
    { workflows: true, code: true, package: false, website: false },
  ],
  [
    "tests/conformance/c/fixture.c",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "scripts/lib/conformance-fixtures.mjs",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "scripts/build-conformance-fixtures.mjs",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "scripts/verify-conformance-fixtures.mjs",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "tests/conformance/swift/fixture.swift",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "tests/conformance/readiness/javascript-cli/package.json",
    { code: true, fixtures: false, readiness: true, package: false },
  ],
  [
    "scripts/verify-reconstruction-readiness.mjs",
    {
      code: true,
      readiness: true,
      fixtures: false,
      runtime: false,
      package: false,
    },
  ],
  [
    "scripts/lib/cli-process-environment.mjs",
    {
      code: true,
      package: true,
      runtime: true,
      javascript_recovery: true,
      readiness: false,
    },
  ],
  [
    "scripts/lib/runtime-admission.mjs",
    {
      code: true,
      package: true,
      runtime: true,
      javascript_recovery: true,
      readiness: false,
    },
  ],
  [
    "scripts/lib/runtime-admission.d.mts",
    {
      code: true,
      package: true,
      runtime: true,
      javascript_recovery: true,
      readiness: false,
    },
  ],
  [
    "tests/conformance/readiness/report/reconstructionReadiness.ts",
    {
      code: true,
      readiness: true,
      fixtures: false,
      runtime: false,
      package: false,
    },
  ],
  [
    "tests/conformance/readiness/report/reconstructionReadinessExample.ts",
    {
      code: true,
      readiness: true,
      fixtures: false,
      runtime: false,
      package: false,
    },
  ],
  [
    "tests/conformance/readiness/report/reconstructionReadiness.test.ts",
    { code: true, readiness: false, runtime: false, package: false },
  ],
  [
    "tests/conformance/ghidra/no-return.c",
    { code: true, fixtures: false, readiness: false, package: false },
  ],
])("preserves scope boundaries for %s", async (path, expected) => {
  expect(await classifyPaths([path])).toMatchObject(expected);
});

it("unions provider scopes across mixed changes and deletions", async () => {
  const { directory } = await fixture();
  const base = await change(directory, ["src/evm/client.ts"]);
  await git(directory, ["rm", "src/evm/client.ts"]);
  const head = await change(directory, ["src/browser/execution/evaluate.ts"]);
  expect(await classify(directory, base, head)).toMatchObject({
    evm: true,
    browser: true,
    runtime: true,
    package: false,
  });
});

it("fails without emitting a plan when package metadata is malformed", async () => {
  const { directory } = await fixture();
  const base = await change(directory, ["package.json"], '{"scripts":{}}');
  const head = await change(directory, ["package.json"], "{broken");
  await expect(runPlanScript(directory, base, head)).rejects.toMatchObject({
    code: 1,
  });
  expect(await readFile(join(directory, "scope-output"), "utf8")).toBe("");
});

it.each([
  [
    "verify:keyed-archive",
    "npm run build:cached && node scripts/verify/apple/keyed-archive.mjs",
    { apple: true, package: false, evm: false, browser: false },
  ],
  [
    "verify:inspector",
    "npm run build:cached && node scripts/verify/inspector/runtime-observation.mjs",
    { package: true, apple: false, evm: false, browser: false },
  ],
  [
    "verify:windows-native",
    "node scripts/verify-windows-native.mjs",
    { package: true, apple: false, evm: false, browser: false },
  ],
])(
  "routes the %s script to its glob-owned lane",
  async (script, command, expected) => {
    expect(
      await classifyPackage(
        JSON.stringify({ scripts: { [script]: command } }),
        JSON.stringify({ scripts: { [script]: `${command} --verbose` } }),
      ),
    ).toMatchObject({
      code: true,
      ...expected,
    });
  },
);

it.each(["knip:production", "lint:typed"])(
  "keeps the %s analysis command within static checks",
  async (script) => {
    expect(
      await classifyPackage(
        JSON.stringify({ scripts: { [script]: "node scripts/old.mjs" } }),
        JSON.stringify({ scripts: { [script]: "node scripts/new.mjs" } }),
      ),
    ).toMatchObject({
      code: true,
      runtime: false,
      package: false,
      evm: false,
      browser: false,
    });
  },
);

it("retains a broad fallback when a provider script adds shared shell work", async () => {
  const { directory } = await fixture();
  const before = {
    scripts: { "verify:evm": "node scripts/verify-evm-interface.mjs" },
  };
  const base = await change(
    directory,
    ["package.json"],
    JSON.stringify(before),
  );
  const after = {
    scripts: {
      "verify:evm": "node scripts/verify-evm-interface.mjs && npm run compile",
    },
  };
  const head = await change(directory, ["package.json"], JSON.stringify(after));
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    runtime: true,
    evm: false,
    browser: false,
    package: false,
  });
});

it.each(["workflow_dispatch", "schedule"])(
  "retains full selection for %s",
  async (event) => {
    const { directory, base } = await fixture();
    expect(await classify(directory, base, base, event)).toMatchObject({
      tier: "full",
      code: true,
      package: true,
      sqlite: true,
      evm: true,
      browser: true,
    });
  },
);

it("honors ci:full for successive PR revisions", async () => {
  const { directory, base } = await fixture();
  const first = await change(directory, ["README.md"]);
  const second = await change(directory, ["docs/readme/README_ja.md"]);
  for (const head of [first, second]) {
    expect(
      await classify(directory, base, head, "pull_request", true),
    ).toMatchObject({
      tier: "full",
      code: true,
      package: true,
      sqlite: true,
      evm: true,
      browser: true,
    });
  }
});

it.each(["compile:termux", "build:termux", "build:termux:run"])(
  "does not expand %s edits into unrelated providers",
  async (script) => {
    expect(
      await classifyPackage(
        JSON.stringify({ scripts: { [script]: "npm run compile:termux" } }),
        JSON.stringify({
          scripts: {
            [script]:
              "node scripts/run-exclusive.mjs artifacts npm run compile:termux",
          },
        }),
      ),
    ).toMatchObject({
      code: true,
      workflows: true,
      runtime: false,
      package: false,
      browser: false,
      evm: false,
    });
  },
);

const INTEL_HOST = {
  os: "macos-15-intel",
  platform: "darwin",
  architecture: "x64",
};

it("keeps macOS x64 package verification only for full qualification", async () => {
  const { directory, base } = await fixture();
  const head = await change(directory, ["src/windows/Example.ts"]);
  const matrix = z.object({ include: z.array(z.unknown()) });
  const hosts = async (event: string, full: boolean) =>
    matrix.parse((await classify(directory, base, head, event, full)).matrix)
      .include;
  const pullRequest = await hosts("pull_request", false);
  expect(pullRequest).toHaveLength(3);
  expect(pullRequest).not.toContainEqual(INTEL_HOST);
  expect(await hosts("pull_request", true)).toContainEqual(INTEL_HOST);
  expect(await hosts("push", false)).not.toContainEqual(INTEL_HOST);
  for (const event of ["schedule", "workflow_dispatch"])
    expect(await hosts(event, false)).toContainEqual(INTEL_HOST);
});

const workflowFile = async (name: string): Promise<unknown> =>
  parse(
    await readFile(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    ),
  );

const scopesSchema = z.object({
  CI_FLAGS: z.array(z.string()),
  CI_LANES: z.record(z.string(), z.object({ paths: z.array(z.string()) })),
  MANUAL_VERIFIERS: z.array(z.string()),
});

const loadScopes = async () =>
  scopesSchema.parse(
    await import(
      new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
    ),
  );

const stepRuns = z.object({
  on: z.unknown(),
  jobs: z.record(
    z.string(),
    z.object({
      steps: z.array(z.object({ run: z.string().optional() })).optional(),
    }),
  ),
});

it("runs the browser request journey in the real browser lane", async () => {
  const workflow = stepRuns.parse(await workflowFile("real-browser.yml"));
  const commands = workflow.jobs["real-browser"]?.steps?.map(
    (step) => step.run,
  );
  expect(commands).toContain("dbus-run-session -- npm run verify:browser");
  expect(commands).toContain(
    "dbus-run-session -- node scripts/verify-browser-request.mjs",
  );
});

it("owns every explicit native-host test path with the lane that runs it", async () => {
  const { CI_LANES } = await loadScopes();
  const ci = stepRuns.parse(await workflowFile("ci.yml"));
  const listed = (job: string) =>
    (ci.jobs[job]?.steps ?? [])
      .flatMap((step) => step.run?.split(/\s+/) ?? [])
      .filter((token) => token.endsWith(".test.ts"));
  const unowned = (job: string, scope: string) =>
    listed(job).filter(
      (path) =>
        !(CI_LANES[scope]?.paths ?? []).some((pattern) =>
          matchesGlob(path, pattern),
        ),
    );
  expect(listed("apple-artifacts").length).toBeGreaterThan(0);
  expect(listed("windows-curated").length).toBeGreaterThan(0);
  expect(unowned("apple-artifacts", "apple")).toEqual([]);
  expect(unowned("windows-curated", "package")).toEqual([]);
});

it("never runs a manual-only verifier from an automatic workflow", async () => {
  const { MANUAL_VERIFIERS } = await loadScopes();
  const scripts = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../package.json", import.meta.url),
          "utf8",
        ),
      ),
    ).scripts;
  const directory = new URL("../../../.github/workflows/", import.meta.url);
  const commands: string[] = [];
  for (const name of await readdir(directory)) {
    const workflow = stepRuns.parse(await workflowFile(name));
    const triggers = JSON.stringify(workflow.on);
    if (
      name !== "ci.yml" &&
      !triggers.includes("workflow_call") &&
      !triggers.includes("pull_request")
    )
      continue;
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) if (step.run) commands.push(step.run);
  }
  const files = new Set<string>();
  const seen = new Set<string>();
  while (commands.length) {
    const command = commands.pop() ?? "";
    for (const [, file] of command.matchAll(/\b(scripts\/[\w./-]+\.mjs)\b/g))
      if (file) files.add(file);
    for (const [, script] of command.matchAll(/npm run ([\w:.-]+)/g)) {
      if (!script || seen.has(script)) continue;
      seen.add(script);
      const body = scripts[script];
      if (body) commands.push(body);
    }
  }
  expect(files.size).toBeGreaterThan(0);
  expect(
    [...files].filter((file) =>
      MANUAL_VERIFIERS.some((pattern) => matchesGlob(file, pattern)),
    ),
  ).toEqual([]);
});

it.each([
  "scripts/run-typescript.mjs",
  "scripts/run-typescript.d.mts",
  "scripts/run-turbo.mjs",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.frida-verification.json",
  "package-lock.json",
  ".nvmrc",
  ".npmrc",
])("selects package hosts for compiler input %s", async (path) => {
  const plan = await classifyPaths([path]);
  expect(plan).toMatchObject({
    tier: "fast",
    code: true,
    runtime: true,
    package: true,
  });
  expect(plan.matrix).toEqual({
    include: [
      { os: "ubuntu-latest", platform: "linux", architecture: "x64" },
      { os: "ubuntu-24.04-arm", platform: "linux", architecture: "arm64" },
      { os: "macos-15", platform: "darwin", architecture: "arm64" },
    ],
  });
});

it.each(["typescript", "tsrs"])(
  "selects fallback host checks when compiler dependency %s changes",
  async (name) => {
    const before = { name: "fixture", devDependencies: { [name]: "1.0.0" } };
    expect(
      await classifyPackage(
        JSON.stringify(before),
        JSON.stringify({ ...before, devDependencies: { [name]: "2.0.0" } }),
      ),
    ).toMatchObject({
      code: true,
      runtime: true,
      package: true,
    });
  },
);

it.each([
  "compile",
  "typecheck",
  "build",
  "build:cached",
  "test:prepare",
  "docs:prepare",
  "verify:frida:bindings",
  "prebuild:cached",
  "postcompile",
  "pretypecheck",
])(
  "selects fallback host checks when compiler command %s changes",
  async (name) => {
    expect(
      await classifyPackage(
        JSON.stringify({ scripts: { [name]: "node scripts/old.mjs" } }),
        JSON.stringify({ scripts: { [name]: "node scripts/new.mjs" } }),
      ),
    ).toMatchObject({
      code: true,
      runtime: true,
      package: true,
    });
  },
);

it("reads a Git blob whose path contains a line break alongside an ordinary blob", async ({
  skip,
}) => {
  skip(
    process.platform === "win32",
    "Windows paths cannot contain line breaks",
  );
  const { directory } = await fixture();
  const path = "src/two\nlines.test.ts";
  const head = await change(directory, [path], "multiline path\n");
  expect(gitRepository(directory).readFiles(head, [path, "README.md"])).toEqual(
    new Map([
      [path, "multiline path\n"],
      ["README.md", "Initial fixture content\n"],
    ]),
  );
});
