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

const stores = {
  object: "const o = {a: {x: 0}}; o.a = shared; o.a.x = 2;",
  array: "const arr = [{x: 0}]; arr[0] = shared; arr[0].x = 2;",
  captured: "const o = {a: {x: 0}}; o.a = shared; const t = o.a; t.x = 2;",
  nested: "const o = {a: {b: {x: 0}}}; o.a.b = shared; o.a.b.x = 2;",
  quoted: 'const o = {}; o["a/b~c"] = shared; o["a/b~c"].x = 2;',
  dynamic: 'const o = {}; const key = "entry"; o[key] = shared; o[key].x = 2;',
  receiverAlias: "const o = {}; const t = o; t.a = shared; o.a.x = 2;",
  transitive: "const p = {}; const o = {}; o.a = p; p.b = shared; o.a.b.x = 2;",
  overwritten: "const o = {}; o.a = {x: 0}; o.a = shared; o.a.x = 2;",
  replacedReference:
    "const o = {}; const other = {x: 0}; o.a = other; o.a = shared; o.a.x = 2;",
  copiedDestination:
    "const o = {}; o.a = shared; const copy = {...o}; copy.a.x = 2;",
  iteration: "const arr = []; arr[0] = shared; for (const t of arr) t.x = 2;",
  nestedArray: "const o = {}; o.a = [shared]; o.a[0].x = 2;",
  orAssignment: "const o = {a: null}; o.a ||= shared; o.a.x = 2;",
  nullishAssignment: "const o = {a: null}; o.a ??= shared; o.a.x = 2;",
  andAssignment: "const o = {a: {x: 0}}; o.a &&= shared; o.a.x = 2;",
  objectPattern: "const o = {}; ({child: o.a} = {child: shared}); o.a.x = 2;",
  arrayPattern: "const o = {}; [o.a] = [shared]; o.a.x = 2;",
  defaultPattern: "const o = {}; ({child: o.a = shared} = {}); o.a.x = 2;",
  objectRestMember:
    "const o = {}; ({...o.a} = {child: shared}); o.a.child.x = 2;",
  arrayRestMember: "const o = {}; [...o.a] = [shared]; o.a[0].x = 2;",
  iteratedObjectRest:
    "const o = {}; for ({...o.a} of [{child: shared}]) o.a.child.x = 2;",
  iteratedArrayRest: "const o = {}; for ([...o.a] of [[shared]]) o.a[0].x = 2;",
  classField:
    "class Holder {} const o = new Holder(); o.a = shared; o.a.x = 2;",
};
const source = [
  ...Object.entries(stores).map(
    ([name, body]) =>
      `export function ${name}() { const shared = {x: 1}; ${body} return shared.x; }`,
  ),
  "export function primitive() { const n = 1; const o = {}; o.a = n; o.a = 2; return n; }",
  "export function nestedChild() { const shared = {inner: {x: 1}}; const o = {}; o.a = shared; o.a.inner.x = 2; return shared.inner.x; }",
  "export function readOnlyStore() { const shared = {x: 1}; const o = {}; o.a = shared; const captured = o.a.x; return shared.x; }",
  "export function copiedScalar() { const shared = {x: 1}; const o = {}; o.a = {...shared}; o.a.x = 2; return shared.x; }",
  "export function copiedArrayScalar() { const shared = {x: 1}; const o = {}; o.a = [shared.x]; o.a[0] = 2; return shared.x; }",
  "export function unrelated() { const shared = {x: 1}; const other = {x: 9}; const o = {}; o.a = shared; o.a.x = 2; return other.x; }",
  "export function copiedChild() { const child = {x: 1}; const parent = {child, keep: 7}; const o = {}; o.a = {...parent}; o.a.child.x = 2; return {child: child.x, keep: parent.keep}; }",
  "export function objectRestExclusion() { const child = {x: 1}; const skip = {x: 3}; const parent = {child, skip, keep: 7}; const o = {}; let ignored; ({skip: ignored, ...o.a} = parent); o.a.child.x = 2; return {child: child.x, skip: skip.x, keep: parent.keep}; }",
  "export function arrayRestOffset() { const child = {x: 1}; const skip = {x: 3}; const items = [skip, child]; const o = {}; let ignored; [ignored, ...o.a] = items; o.a[0].x = 2; return {child: child.x, skip: items[0].x}; }",
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
  for (const name of [...Object.keys(stores), "nestedChild"]) {
    const field = fields(name).find(({ path }) => path === "");
    expect(field, name).toBeDefined();
    expect(field?.state, name).toMatch(/^(unknown|literal)$/);
    if (field?.state === "literal") expect(field.value, name).toBe(2);
  }
  const readOnly = fields("readOnlyStore").find(({ path }) => path === "");
  expect(readOnly?.state).toMatch(/^(unknown|literal)$/);
  if (readOnly?.state === "literal") expect(readOnly.value).toBe(1);
  for (const [name, value] of Object.entries({
    primitive: 1,
    copiedScalar: 1,
    copiedArrayScalar: 1,
    unrelated: 9,
  }))
    expect(fields(name), name).toContainEqual(
      expect.objectContaining({ path: "", state: "literal", value }),
    );
  const child = fields("copiedChild").find(({ path }) => path === "/child");
  expect(child?.state).toMatch(/^(unknown|literal)$/);
  if (child?.state === "literal") expect(child.value).toBe(2);
  expect(fields("copiedChild")).toContainEqual(
    expect.objectContaining({ path: "/keep", state: "literal", value: 7 }),
  );
  for (const name of ["objectRestExclusion", "arrayRestOffset"]) {
    const child = fields(name).find(({ path }) => path === "/child");
    expect(child?.state, name).toMatch(/^(unknown|literal)$/);
    if (child?.state === "literal") expect(child.value, name).toBe(2);
    expect(fields(name), name).toContainEqual(
      expect.objectContaining({ path: "/skip", state: "literal", value: 3 }),
    );
  }
  expect(fields("objectRestExclusion")).toContainEqual(
    expect.objectContaining({ path: "/keep", state: "literal", value: 7 }),
  );
};

cliTest(
  "does not report stale literals after storing references in member slots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-slot-stores-");
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
    const client = new Client({ name: "slot-stores-e2e", version: "1" });
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
