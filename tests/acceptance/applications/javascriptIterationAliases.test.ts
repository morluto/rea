import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { projectedExportReturnShapesSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const source = [
  "export function inline() { const shared = { x: 1, keep: 7 }; for (const t of [shared]) t.x = 2; return { x: shared.x, keep: shared.keep }; }",
  "export function named() { const shared = { x: 1 }; const arr = [shared]; for (const t of arr) t.x = 2; return shared.x; }",
  "export function declaredVar() { const shared = { x: 1 }; for (var t of [shared]) t.x = 2; return shared.x; }",
  "export function assigned() { const shared = { x: 1 }; let t; for (t of [shared]) t.x = 2; return shared.x; }",
  "export function assignedDestructured() { const shared = { x: 1 }; let t; for ({child: t} of [{child: shared}]) t.x = 2; return shared.x; }",
  "export function declaredVarDestructured() { const shared = { x: 1 }; for (var {child: t} of [{child: shared}]) t.x = 2; return shared.x; }",
  "export function memberTarget() { const shared = { x: 1 }; const holder = {}; for (holder.item of [shared]) holder.item.x = 2; return shared.x; }",
  "export function memberPattern() { const shared = { x: 1 }; const holder = {}; for ({child: holder.item} of [{child: shared}]) holder.item.x = 2; return shared.x; }",
  "export function destructured() { const shared = { x: 1 }; for (const {child: t} of [{child: shared}]) t.x = 2; return shared.x; }",
  "export function arrayDestructured() { const shared = { x: 1 }; for (const [t] of [[shared]]) t.x = 2; return shared.x; }",
  "export function spread() { const shared = { x: 1 }; const arr = [shared]; for (const t of [...arr]) t.x = 2; return shared.x; }",
  "export function objectRestChild() { const shared = { x: 1 }; for (const {...t} of [{child: shared}]) t.child.x = 2; return shared.x; }",
  "export function arrayRestChild() { const shared = { x: 1 }; for (const [...t] of [[shared]]) t[0].x = 2; return shared.x; }",
  "export function defaultChild() { const shared = { x: 1 }; for (const {child: t = shared} of [{}]) t.x = 2; return shared.x; }",
  "export function updated() { const shared = { x: 1 }; for (const t of [shared]) t.x++; return shared.x; }",
  "export function deleted() { const shared = { x: 1 }; for (const t of [shared]) delete t.x; return shared.x; }",
  "export function escaped() { const shared = { x: 1 }; for (const t of [shared]) consume(t); return shared.x; }",
  "export async function awaited() { const shared = { x: 1 }; for await (const t of [shared]) t.x = 2; return shared.x; }",
  "export function indexed() { const shared = { x: 1 }; const arr = [shared]; for (let i = 0; i < arr.length; i++) { const t = arr[i]; t.x = 2; } return shared.x; }",
  "export function copyWrite() { const shared = { x: 1 }; for (const {...t} of [shared]) t.x = 2; return shared.x; }",
  "export function noWrite() { const shared = { x: 1 }; for (const t of [shared]) { const read = t.x; } return shared.x; }",
  "export function empty() { const shared = { x: 1 }; for (const t of []) t.x = 2; return shared.x; }",
  "export function keys() { const shared = { x: 1 }; for (const key in [shared]) { const read = key; } return shared.x; }",
  "export function shadowed() { const t = { x: 1 }; const shared = { x: 3 }; for (const t of [shared]) t.x = 2; return t.x; }",
].join("\n");

const assertReturns = (value: unknown): void => {
  const analysis = javascriptApplicationAnalysisResultSchema.parse(value);
  const projections = analysis.graph.nodes
    .flatMap(({ observations }) => observations)
    .filter(
      ({ properties }) => properties.semantic_role === "export-return-shapes",
    )
    .map(({ properties }) =>
      projectedExportReturnShapesSchema.parse(properties),
    );
  const fields = (name: string) => {
    const projection = projections.find(
      ({ exported_name }) => exported_name === name,
    );
    if (projection === undefined) throw new Error(`Missing export ${name}`);
    expect(projection.return_shape_coverage).toMatchObject({
      status: "complete",
      projection_complete: true,
    });
    return projection.static_return_shapes.flatMap(({ fields }) => fields);
  };
  expect(fields("inline")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/x", state: "unknown" }),
      expect.objectContaining({ path: "/keep", state: "literal", value: 7 }),
    ]),
  );
  for (const name of [
    "named",
    "declaredVar",
    "assigned",
    "assignedDestructured",
    "declaredVarDestructured",
    "memberTarget",
    "memberPattern",
    "destructured",
    "arrayDestructured",
    "spread",
    "objectRestChild",
    "arrayRestChild",
    "defaultChild",
    "updated",
    "deleted",
    "escaped",
    "awaited",
    "indexed",
  ])
    expect(fields(name), name).toContainEqual(
      expect.objectContaining({ path: "", state: "unknown" }),
    );
  for (const name of ["copyWrite", "noWrite", "empty", "keys", "shadowed"])
    expect(fields(name), name).toContainEqual(
      expect.objectContaining({ path: "", state: "literal", value: 1 }),
    );
};

cliTest(
  "preserves yielded-object mutation uncertainty through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-iteration-aliases-");
    await writeFile(join(root, "app.js"), source);
    const cliResponse = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(cliResponse.exitCode).toBe(0);
    const contract = toolContract("analyze_javascript_application");
    const cliEvidence = contract.outputSchema.parse(cliResponse.json);
    assertReturns(cliEvidence.normalized_result);
    const client = new Client({ name: "iteration-aliases-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      expect(response.isError).not.toBe(true);
      const evidence = contract.outputSchema.parse(response.structuredContent);
      expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
      assertReturns(evidence.normalized_result);
      const text = response.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP text result");
      assertReturns(
        contract.outputSchema.parse(JSON.parse(text.text)).normalized_result,
      );
      await client.ping();
    } finally {
      await client.close();
      await transport.close();
    }
  },
  120_000,
);
