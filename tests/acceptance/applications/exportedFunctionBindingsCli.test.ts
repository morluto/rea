import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "../../../scripts/lib/mcp-verification-environment.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createCliCommandSession,
  stopOwnedChildProcess,
  type CliCommandSession,
} from "../../support/cli/cliCommandSession.js";
import {
  createCliSessionFrameReader,
  encodeCliSessionFrame,
} from "../../support/cli/cliCommandSessionFrames.mjs";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createSharedMcpSession } from "../../support/mcp/sharedMcpSession.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import { completeApplicationAnalysis } from "../../support/completeDetail.js";

const requireFixture = createRequire(import.meta.url);
const comparisonEnvelope = z.object({
  normalized_result: javaScriptExportShapeComparisonResultSchema,
});
const applicationEnvelope = z.object({
  normalized_result: javascriptApplicationAnalysisResultSchema,
});
let cliSession: CliCommandSession | undefined;
let compileCacheRoot = "";
let compileCacheWorkspace = "";
interface RuntimeExportWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly invoke: (
    entries: readonly (readonly [path: string, exportName: string])[],
  ) => Promise<unknown[]>;
}
let activeRuntimeWorker: RuntimeExportWorker | undefined;
const ownedRuntimeWorkers = new Set<ChildProcessWithoutNullStreams>();
let runtimeQueue: Promise<unknown> = Promise.resolve();

const closeOwnedRuntimeWorkers = async (): Promise<void> => {
  activeRuntimeWorker = undefined;
  const results = await Promise.allSettled(
    [...ownedRuntimeWorkers].map(async (child) => {
      await stopOwnedChildProcess(child, 1_000, "runtime export worker");
      ownedRuntimeWorkers.delete(child);
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Runtime export worker cleanup failed");
};

const mcp = createSharedMcpSession(
  async (registerCleanup) =>
    (
      await connectLocalToolsMcp(
        { ...INLINE_EVIDENCE_MCP_ENVIRONMENT, ...compileCacheEnvironment() },
        registerCleanup,
      )
    ).call,
);

beforeAll(async () => {
  const workspace = await createTestWorkspace("rea-exported-bindings-cache-");
  compileCacheWorkspace = workspace.root;
  compileCacheRoot = workspace.path("compile-cache");
  await mkdir(compileCacheRoot, { recursive: true });
});

afterAll(async () => {
  await closeVerifierResources([
    mcp.close,
    async () => {
      await cliSession?.close();
    },
    closeOwnedRuntimeWorkers,
    async () => {
      if (compileCacheWorkspace !== "")
        await removeTestWorkspace(compileCacheWorkspace);
    },
  ]);
});

describe("exported function binding resolution through stdio MCP and CLI", () => {
  const reassigned = [
    {
      name: "a function declaration exported by a specifier",
      exportName: "default",
      source: (count: number) =>
        `function current() { return { count: 0 }; }
         current = () => ({ count: ${String(count)} });
         export { current as default };`,
    },
    {
      name: "a directly exported function declaration",
      exportName: "current",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         current = () => ({ count: ${String(count)} });`,
    },
    {
      name: "a named default function declaration",
      exportName: "default",
      source: (count: number) =>
        `export default function current() { return { count: 0 }; }
         current = () => ({ count: ${String(count)} });`,
    },
    {
      name: "a directly exported arrow binding",
      exportName: "current",
      source: (count: number) =>
        `export let current = () => ({ count: 0 });
         current = () => ({ count: ${String(count)} });`,
    },
    {
      name: "an arrow binding exported by a specifier",
      exportName: "default",
      source: (count: number) =>
        `let current = () => ({ count: 0 });
         current = () => ({ count: ${String(count)} });
         export { current as default };`,
    },
    {
      name: "a reassigned alias",
      exportName: "default",
      source: (count: number) =>
        `const original = () => ({ count: 0 });
         let current = original;
         current = () => ({ count: ${String(count)} });
         export { current as default };`,
    },
    {
      name: "a conditional function reassignment",
      exportName: "current",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         if (true) current = () => ({ count: ${String(count)} });`,
    },
  ];

  it("keeps each recorded export uncertain after reassignment", async () => {
    const fixtures = await analyzeVersionFixtures(
      reassigned.map(({ name, source, exportName }) => ({
        source,
        exportName,
        fileName: `${name.replaceAll(" ", "-")}.mjs`,
      })),
    );
    const entries = fixtures.flatMap(({ leftPath, rightPath, input }) => [
      [leftPath, input.left_export_name] as const,
      [rightPath, input.right_export_name] as const,
    ]);
    expect(await runtimeExports(entries)).toEqual(
      reassigned.flatMap(() => [{ count: 1 }, { count: 2 }]),
    );
    expectUnresolvedBindings(fixtures);
    expectUncertainComparison(await compareThroughMcp(fixtures.at(-1)!.input));
  });

  it("does not associate a private function name with a numeric export through stdio MCP", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const hidden = function current() { return { count: 0 }; };
       const current = ${String(count)};
       export { current as default };`,
      "default",
    );
    await expectRuntimeExports(fixture, (count) => count);
    const comparison = await compareThroughMcp(fixture.input);
    expectUncertainComparison(comparison);
  });

  it("does not treat rebinding the CommonJS exports alias as a default export", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `exports = function parse() { return { kind: "result", count: ${String(count)} }; };`,
      "default",
      "app.cjs",
    );

    // This is a test-owned fixture, so Node's actual CommonJS loader is the
    // oracle for what the application exports.
    expect(requireFixture(fixture.leftPath)).toEqual({});
    expect(requireFixture(fixture.rightPath)).toEqual({});

    const mcp = await compareThroughMcp(fixture.input);
    await expectCliAnalysisParity(fixture);
    expect(mcp).toMatchObject({
      left: { status: "missing" },
      right: { status: "missing" },
      summary: { added: 0, removed: 0, changed: 0 },
    });
    expect(await compareThroughCli(fixture)).toEqual(mcp);
  });

  it.each([
    ["the CommonJS exports alias", "exports"],
    ["an ordinary object property", "holder.value"],
  ])(
    "resolves exported callable values through = chains ending at %s",
    async (_, target) => {
      const fixture = await analyzeVersions(
        (count) =>
          `const holder = {};\nfunction parse() { return { kind: "result", count: ${String(count)} }; }\nmodule.exports = ${target} = parse;`,
        "default",
        "app.cjs",
      );
      expect(requireFixture(fixture.leftPath)()).toEqual({
        kind: "result",
        count: 1,
      });
      expect(requireFixture(fixture.rightPath)()).toEqual({
        kind: "result",
        count: 2,
      });
      for (const evidence of [fixture.input.left, fixture.input.right])
        expectExportedCallableBinding(evidence, "parse");
      const comparison = await compareThroughMcp(fixture.input);
      expectCountChange(comparison);
      if (target === "exports") {
        await expectCliAnalysisParity(fixture);
        expect(await compareThroughCli(fixture)).toEqual(comparison);
      }
    },
  );
});

describe("CommonJS receiver lifetimes through stdio MCP and CLI", () => {
  it("excludes detached public export receivers", async () => {
    const fixtures = await receiverVersions([
      "module.exports = {}; exports.parse = VALUE;",
      "exports = {}; exports.parse = VALUE;",
      "exports.parse = VALUE; module.exports = {};",
      "module.exports.parse = VALUE; module.exports = {};",
      "module.exports = {}; exports = module.exports; module.exports = {}; exports.parse = VALUE;",
      'module.exports = {}; exports.parse = "enabled";',
      'module.exports = {}; Reflect.set(module, "other", exports); exports.parse = VALUE;',
      "module.exports = {}; let wrapper = module; wrapper = {}; Object.assign(wrapper, { exports }); exports.parse = VALUE;",
    ]);
    for (const fixture of fixtures) {
      for (const path of [fixture.leftPath, fixture.rightPath])
        expect(Object.hasOwn(requireFixture(path), "parse"), path).toBe(false);
    }
    const [representative] = fixtures;
    for (const evidence of [
      representative!.input.left,
      representative!.input.right,
    ]) {
      const { graph } = applicationEnvelope.parse(evidence).normalized_result;
      expect(graph.coverage).toMatchObject({
        status: "complete",
        omitted_count: 0,
      });
      expect(
        graph.nodes
          .flatMap(({ observations }) => observations)
          .flatMap(({ properties }) =>
            properties.semantic_role === "source-module"
              ? [properties.path]
              : [],
          )
          .sort(),
      ).toEqual(fixtures.map(({ input }) => input.left_module_path).sort());
      expect(
        graph.nodes
          .flatMap(({ observations }) => observations)
          .filter(
            ({ properties }) =>
              properties.exported_name === "parse" &&
              (properties.semantic_role === "export-binding" ||
                properties.semantic_role === "export-return-shapes"),
          ),
      ).toEqual([]);
    }
    const comparison = await compareThroughMcp(representative!.input);
    expect(comparison).toMatchObject({
      left: { status: "missing" },
      right: { status: "missing" },
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("retains connected public export receivers", async () => {
    const fixtures = await receiverVersions([
      "exports.parse = VALUE;",
      "module.exports = {}; module.exports.parse = VALUE;",
      "module.exports = {}; exports = module.exports; exports.parse = VALUE;",
      "exports.parse = VALUE; Object.assign(module.exports, { other: exports });",
    ]);
    for (const fixture of fixtures) {
      expectRuntimeReceiver(fixture);
      const comparison = await compareThroughMcp(fixture.input);
      expectCountChange(comparison, fixture.input);
      if (fixture === fixtures[0]) {
        await expectCliAnalysisParity(fixture);
        expect(await compareThroughCli(fixture)).toEqual(comparison);
      }
    }
  });

  it("keeps execution-dependent receiver identity uncertain", async () => {
    const fixtures = await receiverVersions([
      "if (false) module.exports = {}; exports.parse = VALUE;",
      "exports.parse = VALUE; if (false) module.exports = {};",
      "function replace() { module.exports = {}; } exports.parse = VALUE;",
      "function replace() { exports = {}; } exports.parse = VALUE;",
      'const holder = {}; ({ [(module.exports = exports, "x")]: holder.x } = (module.exports = {})); exports.parse = VALUE;',
      'const { [(module.exports = exports, "x")]: value } = (module.exports = {}); exports.parse = VALUE;',
      "const [value = (module.exports = exports)] = (module.exports = []); exports.parse = VALUE;",
      "module.exports = {}; Object.assign(module, { exports }); exports.parse = VALUE;",
      'module.exports = {}; Object.defineProperty(module, "exports", { value: exports }); exports.parse = VALUE;',
      'module.exports = {}; Reflect.set(module, "exports", exports); exports.parse = VALUE;',
      "module.exports = {}; const assign = Object.assign; assign.call(null, module, { exports }); exports.parse = VALUE;",
      "module.exports = {}; const wrapper = module; Object.assign(wrapper, { exports }); exports.parse = VALUE;",
    ]);
    for (const fixture of fixtures) expectRuntimeReceiver(fixture);
    expectUnresolvedBindings(fixtures);
    expectUncertainComparison(await compareThroughMcp(fixtures.at(-1)!.input));
  });
});

describe("CommonJS assignment-chain receiver identity through stdio MCP", () => {
  it("does not export a named write whose captured module.exports receiver is replaced", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const VERSION = ${String(count)};\nmodule.exports.parse = (module.exports = () => ({ count: VERSION }));`,
      "parse",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath]) {
      const value = requireFixture(path);
      expect(typeof value).toBe("function");
      expect(Reflect.ownKeys(value)).toEqual(["length", "name"]);
    }
    for (const evidence of [fixture.input.left, fixture.input.right]) {
      const analysis = applicationEnvelope.parse(evidence).normalized_result;
      expect(
        analysis.graph.nodes
          .flatMap(({ observations }) => observations)
          .filter(
            ({ properties }) =>
              properties.semantic_role === "export-binding" &&
              properties.exported_name === "parse",
          ),
      ).toEqual([]);
    }
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "missing" },
      right: { status: "missing" },
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("keeps a named property export when its receiver remains stable through the RHS chain", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const holder = {};\nfunction parse() { return { kind: "result", count: ${String(count)} }; }\nmodule.exports.parse = holder.value = parse;`,
      "parse",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath])
      expect(requireFixture(path).parse()).toEqual({
        kind: "result",
        count: path === fixture.leftPath ? 1 : 2,
      });
    const comparison = await compareThroughMcp(fixture.input);
    expectCountChange(comparison);
  });

  it("keeps receiver identity unresolved when module.exports is reassigned to the same function", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const VERSION = ${String(count)};\nfunction parse() { return { count: VERSION }; }\nmodule.exports = parse;\nmodule.exports.parse = (module.exports = parse);`,
      "parse",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath]) {
      const value = requireFixture(path);
      expect(value.parse).toBe(value);
      expect(value.parse()).toEqual({
        count: path === fixture.leftPath ? 1 : 2,
      });
    }
    for (const evidence of [fixture.input.left, fixture.input.right])
      expectUnresolvedExportBinding(evidence, "parse");
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "unavailable" },
      right: { status: "unavailable" },
    });
  });

  it("keeps receiver replacement by an existing function unresolved", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const VERSION = ${String(count)};\nfunction parse() { return { count: VERSION }; }\nmodule.exports.parse = (module.exports = parse);`,
      "parse",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath]) {
      const value = requireFixture(path);
      expect(value.parse).toBeUndefined();
      expect(value()).toEqual({
        count: path === fixture.leftPath ? 1 : 2,
      });
    }
    for (const evidence of [fixture.input.left, fixture.input.right])
      expectUnresolvedExportBinding(evidence, "parse");
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "unavailable" },
      right: { status: "unavailable" },
    });
  });

  it("resolves a nested lexical parse binding in an ordinary module.exports chain", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `function parse() { return { count: VERSION }; }\nfunction configure() { const parse = () => ({ count: 7 }); let local; module.exports = local = parse; }\nconst VERSION = ${String(count)};\nconfigure();`,
      "default",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath])
      expect(requireFixture(path)()).toEqual({ count: 7 });
    for (const evidence of [fixture.input.left, fixture.input.right])
      expectExportedCallableBinding(evidence, "parse", { line: 2, count: 7 });
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "selected" },
      right: { status: "selected" },
      summary: { added: 0, removed: 0, changed: 0, unknown: 0 },
      changes: [],
    });
  });
});

describe("CommonJS export identity and scope regressions", () => {
  it("does not export a named write through the original exports alias after replacement", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const VERSION = ${String(count)};\nexports.parse = (module.exports = () => ({ count: VERSION }));`,
      "parse",
      "app.cjs",
    );
    for (const path of [fixture.leftPath, fixture.rightPath]) {
      const value = requireFixture(path);
      expect(typeof value).toBe("function");
      expect(Reflect.ownKeys(value)).toEqual(["length", "name"]);
    }
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "missing" },
      right: { status: "missing" },
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("keeps a dead var shadow of the alias-chain RHS unavailable", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `function parse() { return { count: ${String(count)} }; }\nfunction configure() { if (false) { var parse = () => ({ count: 7 }); } module.exports = exports = parse; }\nconfigure();`,
      "default",
      "app.cjs",
    );
    expect(requireFixture(fixture.leftPath)).toBeUndefined();
    expect(requireFixture(fixture.rightPath)).toBeUndefined();
    const comparison = await compareThroughMcp(fixture.input);
    expectUncertainComparison(comparison);
  });

  it.each(["+=", "||=", "??="] as const)(
    "does not treat module.exports %s as a definite function export",
    async (operator) => {
      const fixture = await analyzeVersions(
        (count) =>
          `module.exports ${operator} (() => ({ kind: "result", count: ${String(count)} }));`,
        "default",
        "app.cjs",
      );
      for (const path of [fixture.leftPath, fixture.rightPath]) {
        const value = requireFixture(path);
        if (operator === "+=") expect(typeof value).toBe("string");
        else expect(value).toEqual({});
      }
      const comparison = await compareThroughMcp(fixture.input);
      expectUncertainComparison(comparison);
    },
  );

  it("keeps a parameter-default mutation unknown in a CommonJS return shape", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const source = { value: 0 }; module.exports = exports = function current(arg = null, set = (arg = source)) { var arg; arg.value = ${String(count)}; return { kind: "result", count: source.value }; };`,
      "default",
      "app.cjs",
    );
    expect(requireFixture(fixture.leftPath)()).toEqual({
      kind: "result",
      count: 1,
    });
    expect(requireFixture(fixture.rightPath)()).toEqual({
      kind: "result",
      count: 2,
    });
    for (const evidence of [fixture.input.left, fixture.input.right]) {
      const analysis = applicationEnvelope.parse(evidence).normalized_result;
      const shapes = analysis.graph.nodes
        .flatMap(({ observations }) => observations)
        .find(
          ({ properties }) =>
            properties.semantic_role === "export-return-shapes" &&
            properties.exported_name === "default",
        )?.properties.static_return_shapes;
      expect(shapes).toEqual([
        expect.objectContaining({
          fields: expect.arrayContaining([
            expect.objectContaining({ path: "/count", state: "unknown" }),
          ]),
        }),
      ]);
    }
    const comparison = await compareThroughMcp(fixture.input);
    expect(comparison).toMatchObject({
      left: { status: "selected" },
      right: { status: "selected" },
      summary: { added: 0, removed: 0, changed: 0, unknown: 1 },
      changes: [
        {
          status: "unknown",
          path: "/count",
          left: { availability: "unknown" },
          right: { availability: "unknown" },
        },
      ],
    });
  });
});

describe("stable exported function bindings through stdio MCP", () => {
  const stable = [
    {
      name: "an anonymous default",
      source: (count: number) =>
        `export default () => ({ kind: "result", count: ${String(count)} });`,
    },
    {
      name: "a named default declaration",
      source: (count: number) =>
        `export default function current() { return { kind: "result", count: ${String(count)} }; }`,
    },
    {
      name: "a private named default expression",
      source: (count: number) =>
        `export default (function current() { return { kind: "result", count: ${String(count)} }; });`,
    },
    {
      name: "a declaration alias",
      source: (count: number) =>
        `function original() { return { kind: "result", count: ${String(count)} }; }
       const current = original; export { current as default };`,
    },
    {
      name: "an unchanged mutable binding",
      source: (count: number) =>
        `let current = () => ({ kind: "result", count: ${String(count)} }); export { current as default };`,
    },
    {
      name: "a private function reached through its real binding",
      source: (count: number) =>
        `const current = function privateName() { return { kind: "result", count: ${String(count)} }; };
       const privateName = 99; const alias = current; export { alias as default };`,
    },
    {
      name: "a declaration sharing a private display name",
      source: (count: number) =>
        `const hidden = function current() { return { count: 99 }; };
       function current() { return { kind: "result", count: ${String(count)} }; }
       export { current as default };`,
    },
  ];

  it("compares each stable export through its exact module binding", async () => {
    const fixtures = await analyzeVersionFixtures(
      stable.map(({ name, source }) => ({
        source,
        exportName: "default",
        fileName: `${name.replaceAll(" ", "-")}.mjs`,
      })),
    );
    for (const { input } of fixtures)
      expectCountChange(await compareThroughMcp(input), input);
  });

  it.each([
    {
      name: "a local callable captured by an identifier default export",
      source: (count: number) =>
        `const run = () => ({ kind: "result", count: ${String(count)} });\nexport default run;`,
      runtimeValue: (count: number) => ({ kind: "result", count }),
      expected: "known",
    },
    {
      name: "the latest callable assigned before the default export",
      source: (count: number) =>
        `let run = () => ({ count: 0 });\nrun = () => ({ kind: "result", count: ${String(count)} });\nexport default run;`,
      runtimeValue: (count: number) => ({ kind: "result", count }),
      expected: "known",
    },
    {
      name: "a callable assigned only after the default export capture",
      source: (count: number) =>
        `var run;\nexport default run;\nrun = () => ({ kind: "result", count: ${String(count)} });`,
      runtimeValue: () => undefined,
      expected: "unknown",
    },
    {
      name: "a reassignment after the default export capture",
      source: (count: number) =>
        `let run = () => ({ kind: "result", count: ${String(count)} });\nexport default run;\nrun = () => ({ count: 99 });`,
      runtimeValue: (count: number) => ({ kind: "result", count }),
      expected: "known",
    },
  ] as const)(
    "uses the value at $name",
    async ({ source, runtimeValue, expected }) => {
      const fixture = await analyzeVersions(source, "default");
      await expectRuntimeExports(fixture, runtimeValue);
      const comparison = await compareThroughMcp(fixture.input);
      if (expected === "known") expectCountChange(comparison);
      else {
        expectUncertainComparison(comparison);
        expect(await compareThroughCli(fixture)).toEqual(comparison);
      }
    },
  );
});

describe("export bindings with loop and assignment-only writes", () => {
  it.each([
    ["a skipped branch", "if (false)"],
    ["a zero-iteration loop", "for (; false;)"],
    ["an unselected switch case", "switch (0) { case 1:"],
    ["an interrupted try block", "try { throw 1;"],
  ])("does not infer a callable initialized in %s", async (_, prefix) => {
    const fixture = await analyzeVersions((count) => {
      const initializer = `var current = () => ({ count: ${String(count)} });`;
      const statement = prefix.startsWith("try")
        ? `${prefix} ${initializer} } catch {}`
        : prefix.startsWith("switch")
          ? `${prefix} ${initializer} }`
          : `${prefix} { ${initializer} }`;
      return `${statement} export { current as default };`;
    }, "default");
    await expectRuntimeExports(fixture, () => undefined);
    expectUncertainComparison(await compareThroughMcp(fixture.input));
  });

  it("retains a var initializer in an unconditional nested block", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `{ var current = () => ({ kind: "result", count: ${String(count)} }); }
         export { current as default };`,
      "default",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughMcp(fixture.input));
  });

  it.each([
    {
      name: "a for-of var declaration",
      loop: (count: number) =>
        `for (var current of [() => ({ count: ${String(count)} })]) {}`,
    },
    {
      name: "a destructured for-of var declaration",
      loop: (count: number) =>
        `for (var { value: current } of [{ value: () => ({ count: ${String(count)} }) }]) {}`,
    },
  ])("keeps $name uncertain", async ({ loop }) => {
    const fixture = await analyzeVersions(
      (count) =>
        `function current() { return { count: 0 }; }
         ${loop(count)}
         module.exports = current;`,
      "default",
      "app.cjs",
    );
    await expectRuntimeExports(fixture, (count) => ({ count }));
    expectUncertainComparison(await compareThroughMcp(fixture.input));
  });

  it("does not associate a for-in key with the overwritten function", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `function current() { return { count: 0 }; }
         for (var current in { ${String(count)}: true }) {}
         module.exports = current;`,
      "default",
      "app.cjs",
    );
    await expectRuntimeExports(fixture, String);
    expectUncertainComparison(await compareThroughMcp(fixture.input));
  });

  it("preserves an outer export shadowed by a lexical loop declaration", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `export function current() { return { kind: "result", count: ${String(count)} }; }
         for (let current of [() => ({ count: 0 })]) { current = null; }`,
      "current",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughMcp(fixture.input));
  });

  it.each([
    {
      name: "a parameter",
      source: (count: number) =>
        `function install(current) {
           if (false) current = () => ({ count: 0 });
           module.exports = current;
         }
         install(${String(count)});`,
    },
    {
      name: "a catch binding",
      source: (count: number) =>
        `try { throw ${String(count)}; } catch (current) {
           if (false) current = () => ({ count: 0 });
           module.exports = current;
         }`,
    },
    {
      name: "a parameter redeclared with var",
      source: (count: number) =>
        `function install(current) {
           if (false) { var current = () => ({ count: 0 }); }
           module.exports = current;
         }
         install(${String(count)});`,
    },
  ])("does not infer $name from its only assignment", async ({ source }) => {
    const fixture = await analyzeVersions(source, "default", "app.cjs");
    await expectRuntimeExports(fixture, (count) => count);
    const comparison = await compareThroughMcp(fixture.input);
    expectUncertainComparison(comparison);
  });
});

describe("export binding lexical scope and declaration order", () => {
  it.each([
    {
      name: "a write before a hoisted function declaration",
      source: (count: number) =>
        `current = () => ({ count: ${String(count)} });
         export function current() { return { count: 0 }; }`,
    },
    {
      name: "a nested write collected before its outer declaration",
      source: (count: number) =>
        `function replace() { current = () => ({ count: ${String(count)} }); }
         export function current() { return { count: 0 }; }
         replace();`,
    },
  ])("keeps $name uncertain", async ({ source }) => {
    const fixture = await analyzeVersions(source, "current");
    await expectRuntimeExports(fixture, (count) => ({ count }));
    expectUncertainComparison(await compareThroughMcp(fixture.input));
  });

  it("does not let a later local declaration contaminate the exported outer binding", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `export function current() { return { kind: "result", count: ${String(count)} }; }
       function isolated() {
         current = () => ({ count: 9 });
         function current() { return { count: 0 }; }
       }
       isolated();`,
      "current",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughMcp(fixture.input));
  });

  it("does not associate a nested CommonJS numeric export with an outer function", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `function current() { return { count: 0 }; }
       function install() { const current = ${String(count)}; module.exports = current; }
       install();`,
      "default",
      "app.cjs",
    );
    await expectRuntimeExports(fixture, (count) => count);
    const comparison = await compareThroughMcp(fixture.input);
    expectUncertainComparison(comparison);
  });

  it.each([
    {
      name: "a nested function-local alias",
      source: (count: number) =>
        `function current() { return { kind: "result", count: 0 }; }
         function install() {
           const actual = () => ({ kind: "result", count: ${String(count)} });
           const current = actual; module.exports = current;
         }
         install();`,
    },
    {
      name: "a block-local function",
      source: (count: number) =>
        `const current = 0;
         { const current = () => ({ kind: "result", count: ${String(count)} });
           module.exports = current; }`,
    },
  ])("compares $name through its real CommonJS binding", async ({ source }) => {
    const fixture = await analyzeVersions(source, "default", "app.cjs");
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughMcp(fixture.input));
  });
});

describe("export writes in function evaluation contexts", () => {
  it.each([
    { body: "var arg; arg.value = COUNT;", uncertain: true },
    { body: "var arg = arg; arg.value = COUNT;", uncertain: true },
    { body: "arg.value = COUNT; var arg;", uncertain: true },
    { body: "arg.value = COUNT; var arg = {};", uncertain: true },
    { body: "var arg = {}; arg.value = COUNT;", uncertain: false },
    { body: "var arg; arg = {}; arg.value = COUNT;", uncertain: false },
    { body: "function arg() {} arg.value = COUNT;", uncertain: false },
  ])("retains parameter-copy timing for $body", async ({ body, uncertain }) => {
    const fixture = await analyzeVersions(
      (count) =>
        `const source = { value: 0 };
         export function current(arg = null, set = (arg = source)) {
           ${body.replace("COUNT", String(count))}
           return { kind: "result", count: source.value };
         }`,
      "current",
    );
    await expectRuntimeExports(fixture, (count) => ({
      kind: "result",
      count: uncertain ? count : 0,
    }));
    for (const evidence of [fixture.input.left, fixture.input.right]) {
      const { normalized_result: analysis } =
        applicationEnvelope.parse(evidence);
      const observations = analysis.graph.nodes.flatMap(
        ({ observations }) => observations,
      );
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              semantic_role: "export-return-shapes",
              exported_name: "current",
              static_return_shapes: [
                expect.objectContaining({
                  fields: expect.arrayContaining([
                    expect.objectContaining({
                      path: "/count",
                      state: uncertain ? "unknown" : "literal",
                      value: uncertain ? null : 0,
                    }),
                  ]),
                }),
              ],
            }),
          }),
        ]),
      );
    }
  });

  it.each([
    ...["let current;", "var current;", "function current() {}"].map(
      (body) => ({
        name: `a parameter default before ${body}`,
        source: (count: number) =>
          `export function current() { return { count: 0 }; }
         function replace(value = (current = () => ({ count: ${String(count)} }))) {
           ${body}
         }
         replace();`,
      }),
    ),
    {
      name: "a closure invoked from a parameter default",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         function replace(value = (() => { current = () => ({ count: ${String(count)} }); })()) {
           let current;
         }
         replace();`,
    },
    {
      name: "a computed destructuring parameter key",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         function replace({ [current = () => ({ count: ${String(count)} })]: value }) {
           var current;
         }
         replace({});`,
    },
    {
      name: "an object method's computed key",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         const object = { [current = () => ({ count: ${String(count)} })]() { let current; } };`,
    },
    {
      name: "a class method's computed key",
      source: (count: number) =>
        `export function current() { return { count: 0 }; }
         class Example { [current = () => ({ count: ${String(count)} })]() { var current; } }`,
    },
  ])("keeps an outer export write in $name uncertain", async ({ source }) => {
    const fixture = await analyzeVersions(source, "current");
    await expectRuntimeExports(fixture, (count) => ({ count }));
    expectUncertainComparison(await compareThroughMcp(fixture.input));
  });

  it("resolves a CommonJS export in a parameter default outside the function body", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `function current() { return { kind: "result", count: ${String(count)} }; }
         function install(value = (module.exports = current)) { var current = 9; }
         install();`,
      "default",
      "app.cjs",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughMcp(fixture.input));
  });
});

it("retains runtime namespace re-exports and erases type-only re-exports through stdio MCP and CLI", async () => {
  const root = await createTestTempDirectory("rea-namespace-reexports-");
  const declarations = [
    { clause: "* as ns", name: "ns", imported: "*" },
    {
      clause: '* as "namespace value"',
      name: "namespace value",
      imported: "*",
    },
    { clause: "{ value as forwarded }", name: "forwarded", imported: "value" },
    { clause: "*", name: "*", imported: "*" },
  ];
  const source = declarations
    .map(({ clause }) => `export ${clause} from "./dependency.mjs";`)
    .join("\n");
  const path = join(root, "barrel.mjs");
  await Promise.all([
    writeFile(path, source),
    writeFile(join(root, "dependency.mjs"), "export const value = 42;"),
  ]);
  const values = await runtimeExports(
    ["ns", "namespace value", "forwarded", "value"].map((name) => [path, name]),
  );
  expect(values).toEqual([{ value: 42 }, { value: 42 }, 42, 42]);

  const typePath = join(root, "barrel.mts");
  await Promise.all([
    writeFile(
      typePath,
      'export type * as Types from "./types.mjs";\nexport * as Values from "./values.mjs";',
    ),
    writeFile(
      join(root, "types.mjs"),
      'throw new Error("Type-only dependency must not execute");',
    ),
    writeFile(join(root, "values.mjs"), "export const value = 42;"),
  ]);
  const namespace = requireFixture(typePath);
  expect(Object.keys(namespace)).toEqual(["Values"]);
  expect({ ...namespace.Values }).toEqual({ value: 42 });

  const documents = [
    await analyzeThroughMcp(root),
    await runCli(completeApplicationAnalysis(root)),
  ];
  const digest = createHash("sha256").update(source).digest("hex");
  for (const document of documents) {
    const { graph } = applicationEnvelope.parse(document).normalized_result;
    const sourceNode = (path: string) =>
      graph.nodes.find(({ observations }) =>
        observations.some(
          ({ properties }) =>
            properties.semantic_role === "source-module" &&
            properties.path === path,
        ),
      );
    const sourceModule = sourceNode("barrel.mjs");
    expect(sourceModule?.observations[0]?.properties).toMatchObject({
      export_relationships: 4,
      export_names: ["*", "forwarded", "namespace value", "ns"],
      omitted_export_names: 0,
    });
    for (const [index, { clause, name, imported }] of declarations.entries()) {
      const exported = exportBinding(graph, "barrel.mjs", name);
      const observation = exported?.observations[0];
      expect(observation?.properties).toMatchObject({
        relationship_kind: "re-export",
        declared_specifier: "./dependency.mjs",
        imported_name: imported,
        local_name: null,
      });
      if (imported === "*" && name !== "*")
        expect(observation?.evidence).toMatchObject({
          artifact: { available: true, sha256: digest },
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: "barrel.mjs",
              start: { line: index + 1, column: 7 },
              end: { line: index + 1, column: 7 + clause.length },
            },
          },
        });
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          source_node_id: sourceModule?.node_id,
          target_node_id: exported?.node_id,
          relation: "exposes",
          properties: expect.objectContaining({ exported_name: name }),
          evidence: expect.objectContaining({
            artifact: observation?.evidence.artifact,
            location: observation?.evidence.location,
          }),
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          source_node_id: exported?.node_id,
          target_node_id: sourceNode("dependency.mjs")?.node_id,
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: "re-export",
            imported_name: imported,
            exported_name: name,
            resolved_path: "dependency.mjs",
            resolution_status: "resolved",
          }),
        }),
      );
    }
    expect(sourceNode("barrel.mts")?.observations[0]?.properties).toMatchObject(
      {
        export_relationships: 1,
        export_names: ["Values"],
        omitted_export_names: 0,
      },
    );
    expect(exportBinding(graph, "barrel.mts", "Types")).toBeUndefined();
    expect(
      graph.edges.some(
        ({ properties }) =>
          properties.exported_name === "Types" ||
          properties.specifier === "./types.mjs",
      ),
    ).toBe(false);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source_node_id: sourceNode("barrel.mts")?.node_id,
        relation: "exposes",
        target_node_id: exportBinding(graph, "barrel.mts", "Values")?.node_id,
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source_node_id: exportBinding(graph, "barrel.mts", "Values")?.node_id,
        target_node_id: sourceNode("values.mjs")?.node_id,
        relation: "imports",
        properties: expect.objectContaining({ resolved_path: "values.mjs" }),
      }),
    );
    expect(graph.coverage).toMatchObject({
      status: "complete",
      omitted_count: 0,
      truncated: false,
    });
  }
});

const expectRuntimeExports = async (
  fixture: Awaited<ReturnType<typeof analyzeVersions>>,
  expected: (count: number) => unknown,
): Promise<void> => {
  // Execute only source-owned fixtures as an independent runtime oracle.
  const entries = [
    [fixture.leftPath, fixture.input.left_export_name, 1],
    [fixture.rightPath, fixture.input.right_export_name, 2],
  ] as const;
  const values = await runtimeExports(
    entries.map(([path, exportName]) => [path, exportName]),
  );
  for (const [index, [, , count]] of entries.entries())
    expect(values[index]).toEqual(expected(count));
};

const expectExportedCallableBinding = (
  evidence: unknown,
  localName: string,
  returned?: { readonly line: number; readonly count: number },
): void => {
  const analysis = applicationEnvelope.parse(evidence).normalized_result;
  const exported = analysis.graph.nodes.find(({ observations }) =>
    observations.some(
      ({ properties }) =>
        properties.semantic_role === "export-binding" &&
        properties.exported_name === "default" &&
        properties.local_name === localName,
    ),
  );
  expect(exported).toBeDefined();
  if (returned !== undefined)
    expect(exported?.observations).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          semantic_role: "export-return-shapes",
          exported_name: "default",
          static_return_shapes: [
            expect.objectContaining({
              fields: [
                expect.objectContaining({
                  path: "/count",
                  state: "literal",
                  value: returned.count,
                }),
              ],
            }),
          ],
        }),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            value: expect.objectContaining({
              source: "app.cjs",
              start: expect.objectContaining({ line: returned.line }),
            }),
          }),
        }),
      }),
    );
};

type ApplicationGraph = z.infer<
  typeof applicationEnvelope
>["normalized_result"]["graph"];

const graphFor = (document: unknown): ApplicationGraph =>
  applicationEnvelope.parse(document).normalized_result.graph;

const exportBinding = (graph: ApplicationGraph, path: string, name: string) =>
  graph.nodes.find(({ observations }) =>
    observations.some(
      ({ properties }) =>
        properties.semantic_role === "export-binding" &&
        properties.module_path === path &&
        properties.exported_name === name,
    ),
  );

const expectUnresolvedExportBinding = (
  evidence: unknown,
  exportName: string,
): void => {
  const observations = graphFor(evidence).nodes.flatMap(
    ({ observations }) => observations,
  );
  const roles = observations
    .filter(({ properties }) => properties.exported_name === exportName)
    .map(({ properties }) => properties.semantic_role);
  expect(roles).toContain("export-binding");
  expect(roles).not.toContain("export-return-shapes");
};

const expectUnresolvedBindings = (
  fixtures: Awaited<ReturnType<typeof analyzeVersionFixtures>>,
): void => {
  const { left, right } = fixtures[0]!.input;
  for (const graph of [graphFor(left), graphFor(right)]) {
    expect(graph.coverage).toMatchObject({
      status: "complete",
      omitted_count: 0,
    });
    const shapes = graph.nodes
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties }) => properties.semantic_role === "export-return-shapes",
      );
    for (const { input } of fixtures) {
      const node = exportBinding(
        graph,
        input.left_module_path,
        input.left_export_name,
      );
      expect(node, input.left_module_path).toBeDefined();
      expect(
        shapes.some(
          ({ properties }) =>
            properties.module_path === input.left_module_path &&
            properties.exported_name === input.left_export_name,
        ),
        input.left_module_path,
      ).toBe(false);
    }
  }
};

const expectUncertainComparison = (
  result: Awaited<ReturnType<typeof compareThroughCli>>,
): void => {
  expect(result).toMatchObject({
    left: { status: "unavailable" },
    right: { status: "unavailable" },
    summary: { added: 0, removed: 0, changed: 0, unknown: 1 },
    changes: [{ status: "unknown", path: "" }],
    coverage: { status: "partial" },
  });
  expect(result.property_inventories).toEqual([]);
};

const expectCountChange = (
  result: Awaited<ReturnType<typeof compareThroughCli>>,
  input?: Awaited<ReturnType<typeof analyzeVersions>>["input"],
): void => {
  expect(result).toMatchObject({
    left: { status: "selected" },
    right: { status: "selected" },
    summary: { added: 0, removed: 0, changed: 1, unknown: 0 },
    changes: [
      {
        path: "/count",
        status: "changed",
        left: { availability: "literal", value: 1 },
        right: { availability: "literal", value: 2 },
      },
    ],
    coverage: { status: "complete-within-inputs" },
  });
  if (input === undefined) return;
  for (const side of ["left", "right"] as const) {
    const path = input[`${side}_module_path`];
    const name = input[`${side}_export_name`];
    const selected = exportBinding(graphFor(input[side]), path, name);
    expect(result[side].selected_node_id, `${side}: ${path}:${name}`).toBe(
      selected?.node_id,
    );
  }
};

const compileCacheEnvironment = () =>
  compileCacheRoot === "" || process.env.NODE_V8_COVERAGE !== undefined
    ? {}
    : { NODE_COMPILE_CACHE: compileCacheRoot };

const runCli = async (args: readonly string[]): Promise<unknown> => {
  cliSession ??= createCliCommandSession({
    startTimeoutMs: 20_000,
    requestTimeoutMs: 20_000,
  });
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      REA_LOG_LEVEL: "silent",
      ...compileCacheEnvironment(),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = await cliSession.run({
    arguments: args,
    cwd: process.cwd(),
    environment,
  });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.json;
};

const analyzeVersionFixtures = async (
  specs: readonly {
    readonly source: (count: number) => string;
    readonly exportName: string;
    readonly fileName: string;
  }[],
) => {
  const root = await createTestTempDirectory("rea-exported-function-bindings-");
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  await Promise.all(
    specs.flatMap(({ source, fileName }) => [
      writeFile(join(leftRoot, fileName), source(1)),
      writeFile(join(rightRoot, fileName), source(2)),
    ]),
  );
  // The same parked worker analyzes the two versions of the directory.
  const left = await analyzeThroughMcp(leftRoot);
  const right = await analyzeThroughMcp(rightRoot);
  return specs.map(({ exportName, fileName }) => ({
    root,
    leftPath: join(leftRoot, fileName),
    rightPath: join(rightRoot, fileName),
    input: {
      left,
      right,
      left_module_path: fileName,
      left_export_name: exportName,
      right_module_path: fileName,
      right_export_name: exportName,
    },
  }));
};

const analyzeVersions = async (
  source: (count: number) => string,
  exportName: string,
  fileName = "app.mjs",
) => (await analyzeVersionFixtures([{ source, exportName, fileName }]))[0]!;

const receiverVersions = (sources: readonly string[]) =>
  analyzeVersionFixtures(
    sources.map((source, index) => ({
      source: (count) =>
        source.replace(
          "VALUE",
          `() => ({ kind: "result", count: ${String(count)} })`,
        ),
      exportName: "parse",
      fileName: `receiver-${String(index)}.cjs`,
    })),
  );

const expectRuntimeReceiver = (
  fixture: Awaited<ReturnType<typeof analyzeVersions>>,
): void => {
  for (const [path, count] of [
    [fixture.leftPath, 1],
    [fixture.rightPath, 2],
  ] as const)
    expect(requireFixture(path).parse(), path).toEqual({
      kind: "result",
      count,
    });
};

const analyzeThroughMcp = async (inputPath: string) => {
  const call = await mcp.session.call();
  const response = await call("analyze_javascript_application", {
    detail: "complete",
    input_path: inputPath,
    format: "auto",
  });
  expect(response.isError).not.toBe(true);
  return response.structuredContent;
};

const expectCliAnalysisParity = async (
  fixture: Awaited<ReturnType<typeof analyzeVersions>>,
): Promise<void> => {
  for (const [root, evidence] of [
    [join(fixture.root, "left"), fixture.input.left],
    [join(fixture.root, "right"), fixture.input.right],
  ] as const) {
    const cli = applicationEnvelope.parse(
      await runCli(completeApplicationAnalysis(root)),
    );
    const mcp = applicationEnvelope.parse(evidence);
    expect(cli.normalized_result).toEqual(mcp.normalized_result);
  }
};

const compareThroughCli = async (
  fixture: Awaited<ReturnType<typeof analyzeVersions>>,
) => {
  const inputPath = join(fixture.root, "comparison.json");
  await writeFile(inputPath, JSON.stringify(fixture.input));
  return comparisonEnvelope.parse(
    await runCli(["compare-javascript-export-shapes", inputPath, "--json"]),
  ).normalized_result;
};

const compareThroughMcp = async (input: Record<string, unknown>) => {
  const call = await mcp.session.call();
  const response = await call("compare_javascript_export_shapes", input);
  expect(response.isError).not.toBe(true);
  return comparisonEnvelope.parse(response.structuredContent).normalized_result;
};

const runtimeReplySchema = z.object({
  id: z.number(),
  ok: z.boolean(),
  results: z.array(z.object({ value: z.unknown().optional() })).optional(),
  error: z.string().optional(),
});

const startRuntimeWorker = (): RuntimeExportWorker => {
  const framesUrl = pathToFileURL(
    resolve("tests/support/cli/cliCommandSessionFrames.mjs"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { pathToFileURL } from 'node:url';
       import { createCliSessionFrameReader, encodeCliSessionFrame } from ${JSON.stringify(framesUrl)};
       const writeFrameStdout = process.stdout.write.bind(process.stdout);
       process.stdout.write = () => true;
       const send = (payload) => new Promise((resolveSend, rejectSend) => {
         writeFrameStdout(encodeCliSessionFrame(payload), (err) => err ? rejectSend(err) : resolveSend());
       });
       let chain = Promise.resolve();
       const reader = createCliSessionFrameReader((request) => {
         chain = chain.then(async () => {
           const { id, entries } = request;
           try {
             const results = [];
             for (const [path, exportName] of entries) {
               const module = await import(pathToFileURL(path).href);
               const value = module[exportName];
               results.push({ value: typeof value === 'function' ? value() : value });
             }
             await send({ id, ok: true, results });
           } catch (error) {
             await send({ id, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
           }
         });
       });
       process.stdin.on('data', (chunk) => reader(chunk));`,
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  ownedRuntimeWorkers.add(child);
  let nextId = 1;
  let brokenCause: unknown;
  const pending = new Map<
    number,
    { resolve: (value: unknown[]) => void; reject: (error: unknown) => void }
  >();
  let workerInstance: RuntimeExportWorker | undefined;
  const retireWorker = (cause: unknown) => {
    brokenCause ??= cause;
    if (activeRuntimeWorker === workerInstance) activeRuntimeWorker = undefined;
    for (const handler of pending.values()) handler.reject(brokenCause);
    pending.clear();
  };
  const reader = createCliSessionFrameReader((raw: unknown) => {
    const parsed = runtimeReplySchema.parse(raw);
    const handler = pending.get(parsed.id);
    if (handler === undefined) {
      throw new Error(
        `Unexpected runtime export reply id ${String(parsed.id)}`,
      );
    }
    pending.delete(parsed.id);
    if (!parsed.ok) {
      handler.reject(new Error(parsed.error ?? "runtime worker failed"));
      return;
    }
    handler.resolve((parsed.results ?? []).map(({ value }) => value));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      reader(chunk);
    } catch (cause) {
      retireWorker(cause);
    }
  });
  child.stderr.on("data", () => undefined);
  child.on("error", retireWorker);
  child.on("exit", (code, signal) => {
    retireWorker(
      new Error(
        `runtime worker exited (${String(code ?? signal ?? "unknown")})`,
      ),
    );
  });
  workerInstance = {
    child,
    invoke: (entries) =>
      new Promise<unknown[]>((resolveRun, rejectRun) => {
        if (brokenCause !== undefined) {
          rejectRun(brokenCause);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: resolveRun, reject: rejectRun });
        child.stdin.write(encodeCliSessionFrame({ id, entries }), (error) => {
          if (error) {
            pending.delete(id);
            retireWorker(error);
            rejectRun(error);
          }
        });
      }),
  };
  return workerInstance;
};

const runtimeExports = (
  entries: readonly (readonly [path: string, exportName: string])[],
): Promise<unknown[]> => {
  const run = async (): Promise<unknown[]> => {
    if (activeRuntimeWorker === undefined && ownedRuntimeWorkers.size > 0) {
      await closeOwnedRuntimeWorkers();
    }
    const worker = (activeRuntimeWorker ??= startRuntimeWorker());
    const values = await worker.invoke(entries);
    expect(values).toHaveLength(entries.length);
    return values;
  };
  const scheduled = runtimeQueue.then(run);
  runtimeQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
};
