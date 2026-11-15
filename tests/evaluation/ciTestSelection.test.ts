import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  parseTestSelection,
  planTestSelection,
  testShards,
} from "../../scripts/ci/test-selection.mjs";

const execute = promisify(execFile);

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
  result.groups.flat().toSorted();

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

it("lets checker-only inputs and prose select nothing by themselves", () => {
  const sources = {
    "src/domain/Value.test.ts": "",
    "tests/boundary/filesystem/docs.test.ts": 'read("docs/guide.md");',
  };
  // A declaration, guard baseline or schema summary adds no tests…
  expect(
    selectedFiles(
      plan(
        [
          "src/domain/Value.test.ts",
          "scripts/lib/helper.d.mts",
          "scripts/verify/baselines/some-guard.json",
          "scripts/verify/advertised-schemas/tools/tool.json",
        ],
        sources,
      ),
    ),
  ).toEqual(["src/domain/Value.test.ts"]);
  // …and prose selects the tests that read it by path.
  expect(selectedFiles(plan(["docs/guide.md"], sources))).toEqual([
    "tests/boundary/filesystem/docs.test.ts",
  ]);
  expect(plan(["scripts/verify/baselines/x.json"], sources)).toMatchObject({
    mode: "full",
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
  // Other scripts remain untraced inputs.
  expect(plan(["scripts/build.mjs"], sources)).toMatchObject({
    mode: "full",
    reason: "Input is not traced to tests: scripts/build.mjs",
  });
});

it("parses only well-formed plans and derives one shard per selected group", () => {
  const selected = {
    version: 2,
    mode: "selected",
    reason: "Affected tests: 2 changed",
    groups: [["src/a.test.ts"], ["tests/b.test.ts"]],
  };
  expect(
    testShards("fast", parseTestSelection(JSON.stringify(selected))),
  ).toEqual(["1/2", "2/2"]);
  const full = { version: 2, mode: "full", reason: "Shared", groups: [] };
  expect(testShards("fast", parseTestSelection(full))).toHaveLength(12);
  expect(testShards("full", parseTestSelection(full))).toHaveLength(6);
  for (const value of [
    "",
    "null",
    { ...selected, mode: "candidate" },
    { ...selected, groups: [[]] },
    { ...selected, groups: [["src/a.ts"]] },
    { ...selected, groups: [["/abs/a.test.ts"]] },
    { ...selected, groups: [["src/a.test.ts"], ["src/a.test.ts"]] },
    {
      ...selected,
      groups: Array.from({ length: 5 }, (_, i) => [`src/${i}.test.ts`]),
    },
  ])
    expect(() => parseTestSelection(value)).toThrow(
      /Invalid portable test selection plan|JSON/u,
    );
});

it("runs only a group the plan defines", async () => {
  const group = fileURLToPath(
    new URL("../../scripts/ci/test-group.mjs", import.meta.url),
  );
  const selection = JSON.stringify({
    version: 2,
    mode: "selected",
    reason: "Affected tests: 1 changed",
    groups: [["src/a.test.ts"]],
  });
  for (const [shard, environment] of [
    ["2/2", selection],
    ["1/2", selection],
    [
      "1/1",
      JSON.stringify({ version: 2, mode: "full", reason: "x", groups: [] }),
    ],
    ["1/1", ""],
  ] as const)
    await expect(
      execute(process.execPath, [group, "selected", shard], {
        env: { ...process.env, CI_TEST_SELECTION: environment },
      }),
    ).rejects.toMatchObject({ code: 1 });
  await expect(
    execute(process.execPath, [group, "selected", "1/1", "--shard=1/2"], {
      env: { ...process.env, CI_TEST_SELECTION: selection },
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("already sharded"),
  });
});
