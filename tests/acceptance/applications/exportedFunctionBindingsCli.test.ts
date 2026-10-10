import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const comparisonEnvelope = z.object({
  normalized_result: javaScriptExportShapeComparisonResultSchema,
});

describe("exported function binding resolution through the CLI", () => {
  it.each([
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
  ])(
    "keeps $name uncertain after reassignment",
    async ({ source, exportName }) => {
      const fixture = await analyzeVersions(source, exportName);
      await expectRuntimeExports(fixture, (count) => ({ count }));
      const result = await compareThroughCli(fixture);
      expectUncertainComparison(result);
      for (const evidence of [fixture.input.left, fixture.input.right]) {
        const { normalized_result: analysis } = z
          .object({
            normalized_result: javascriptApplicationAnalysisResultSchema,
          })
          .parse(evidence);
        expect(
          analysis.graph.nodes
            .flatMap(({ observations }) => observations)
            .filter(
              ({ properties }) =>
                properties.semantic_role === "export-return-shapes" &&
                properties.exported_name === exportName,
            ),
        ).toEqual([]);
      }
    },
  );

  it("does not associate a private function name with a numeric export in CLI or MCP", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `const hidden = function current() { return { count: 0 }; };
       const current = ${String(count)};
       export { current as default };`,
      "default",
    );
    await expectRuntimeExports(fixture, (count) => count);
    const cli = await compareThroughCli(fixture);
    expectUncertainComparison(cli);
    expect(await compareThroughMcp(fixture.input)).toEqual(cli);
  });
});

describe("stable exported function bindings through the CLI", () => {
  it.each([
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
  ])("retains exact comparison for $name", async ({ source }) => {
    const fixture = await analyzeVersions(source, "default");
    expectCountChange(await compareThroughCli(fixture));
  });
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
    expectUncertainComparison(await compareThroughCli(fixture));
  });

  it("retains a var initializer in an unconditional nested block", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `{ var current = () => ({ kind: "result", count: ${String(count)} }); }
         export { current as default };`,
      "default",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughCli(fixture));
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
    expectUncertainComparison(await compareThroughCli(fixture));
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
    expectUncertainComparison(await compareThroughCli(fixture));
  });

  it("preserves an outer export shadowed by a lexical loop declaration", async () => {
    const fixture = await analyzeVersions(
      (count) =>
        `export function current() { return { kind: "result", count: ${String(count)} }; }
         for (let current of [() => ({ count: 0 })]) { current = null; }`,
      "current",
    );
    await expectRuntimeExports(fixture, (count) => ({ kind: "result", count }));
    expectCountChange(await compareThroughCli(fixture));
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
    const cli = await compareThroughCli(fixture);
    expectUncertainComparison(cli);
    expect(await compareThroughMcp(fixture.input)).toEqual(cli);
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
    expectUncertainComparison(await compareThroughCli(fixture));
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
    expectCountChange(await compareThroughCli(fixture));
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
    const cli = await compareThroughCli(fixture);
    expectUncertainComparison(cli);
    expect(await compareThroughMcp(fixture.input)).toEqual(cli);
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
    expectCountChange(await compareThroughCli(fixture));
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
      const { normalized_result: analysis } = z
        .object({
          normalized_result: javascriptApplicationAnalysisResultSchema,
        })
        .parse(evidence);
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
    expectUncertainComparison(await compareThroughCli(fixture));
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
    expectCountChange(await compareThroughCli(fixture));
  });
});

const expectRuntimeExports = async (
  fixture: Awaited<ReturnType<typeof analyzeVersions>>,
  expected: (count: number) => unknown,
): Promise<void> => {
  // Execute only source-owned fixtures as an independent runtime oracle.
  for (const [path, exportName, count] of [
    [fixture.leftPath, fixture.input.left_export_name, 1],
    [fixture.rightPath, fixture.input.right_export_name, 2],
  ] as const)
    expect(await runtimeExport(path, exportName)).toEqual(expected(count));
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
};

const runCli = async (args: readonly string[]): Promise<unknown> => {
  const { stdout } = await execute(
    process.execPath,
    [resolve("scripts/rea.mjs"), ...args],
    {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    },
  );
  return JSON.parse(stdout);
};

const analyzeVersions = async (
  source: (count: number) => string,
  exportName: string,
  fileName = "app.mjs",
) => {
  const root = await createTestTempDirectory("rea-exported-function-bindings-");
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  const leftPath = join(leftRoot, fileName);
  const rightPath = join(rightRoot, fileName);
  await Promise.all([
    writeFile(leftPath, source(1)),
    writeFile(rightPath, source(2)),
  ]);
  const [left, right] = await Promise.all([
    runCli(["analyze-javascript-application", leftRoot, "--json"]),
    runCli(["analyze-javascript-application", rightRoot, "--json"]),
  ]);
  return {
    root,
    leftPath,
    rightPath,
    input: {
      left,
      right,
      left_module_path: fileName,
      left_export_name: exportName,
      right_module_path: fileName,
      right_export_name: exportName,
    },
  };
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
    stderr: "pipe",
  });
  const client = new Client({
    name: "exported-function-bindings",
    version: "1",
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "compare_javascript_export_shapes",
      arguments: input,
    });
    expect(response.isError).not.toBe(true);
    return comparisonEnvelope.parse(response.structuredContent)
      .normalized_result;
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
};

const runtimeExport = async (
  path: string,
  exportName: string,
): Promise<unknown> => {
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "-e",
    `import { pathToFileURL } from 'node:url';
     const module = await import(pathToFileURL(process.argv[1]).href);
     const value = module[process.argv[2]];
     console.log(JSON.stringify({ value: typeof value === 'function' ? value() : value }));`,
    path,
    exportName,
  ]);
  return z.object({ value: z.unknown().optional() }).parse(JSON.parse(stdout))
    .value;
};
