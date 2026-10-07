import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { compareJavaScriptExportShapes } from "../../../src/domain/javascript/javascriptExportShapeComparison.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";

describe("JavaScript export return-shape comparison", () => {
  it("reports exactly the heading depth addition from source-owned parser fixtures", async () => {
    const root = await temporaryRoot();
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        resolve("tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        resolve("tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const [left, right] = await Promise.all([
      analyzeGraph(leftRoot),
      analyzeGraph(rightRoot),
    ]);

    const first = compare(left, right);
    const second = compare(left, right);

    expect(first.comparison_id).toBe(second.comparison_id);
    expect(() =>
      javaScriptExportShapeComparisonResultSchema.parse(first),
    ).not.toThrow();
    expect(first.summary).toEqual({
      added: 1,
      removed: 0,
      changed: 0,
      unknown: 0,
    });
    expect(first.changes).toEqual([
      expect.objectContaining({
        status: "added",
        path: "/depth",
        discriminant: { path: "/type", value: "heading" },
        left: { availability: "absent" },
        right: { availability: "literal", value: 1 },
      }),
    ]);
    expect(first.changes.some(({ path }) => path === "/text")).toBe(false);
    expect(first.coverage).toMatchObject({
      status: "complete-within-inputs",
      paired_variants: 3,
      unpaired_left_variants: 0,
      unpaired_right_variants: 0,
    });
    expect(first.limitations).toContain(
      "This static comparison cannot establish runtime semantics; run behavioral probes directly against the relevant application versions when that evidence is required.",
    );
  });

  it("keeps additions unknown when spread coverage is incomplete", async () => {
    const [left, right] = await analyzeSources({
      left: `
        const dynamic = getDynamic();
        export default () => ({ ...dynamic, type: "heading" });
      `,
      right: `
        const dynamic = getDynamic();
        export default () => ({ depth: 1, ...dynamic, type: "heading" });
      `,
    });
    const result = compare(left, right);

    expect(result.changes).toEqual([
      expect.objectContaining({ status: "unknown", path: "/depth" }),
    ]);
    expect(result.coverage.status).toBe("partial");
  });

  it("does not pair discriminants that an unknown trailing spread can overwrite", async () => {
    const [left, right] = await analyzeSources({
      left: `
        const dynamic = getDynamic();
        export default () => ({ type: "heading", ...dynamic });
      `,
      right: `
        const dynamic = getDynamic();
        export default () => ({ type: "heading", depth: 1, ...dynamic });
      `,
    });
    const result = compare(left, right);

    expect(result.changes).toEqual([
      expect.objectContaining({
        status: "unknown",
        path: "",
        discriminant: null,
      }),
      expect.objectContaining({
        status: "unknown",
        path: "",
        discriminant: null,
      }),
    ]);
    expect(result.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unknown: 2,
    });
    expect(result.coverage).toMatchObject({
      status: "partial",
      paired_variants: 0,
      unpaired_left_variants: 1,
      unpaired_right_variants: 1,
    });
  });

  it("does not pair ambiguous variants or invent behavior for no-return exports", async () => {
    const ambiguous = await analyzeSources({
      left: `
        export default function parse(value) {
          if (value) return { type: "heading", text: render(value) };
          return { type: "heading", text: render(value) };
        }
      `,
      right: `export default (value) => ({ type: "heading", text: render(value) });`,
    });
    const compared = compare(...ambiguous);
    expect(compared.summary.unknown).toBe(3);
    expect(compared.coverage).toMatchObject({
      status: "partial",
      paired_variants: 0,
      unpaired_left_variants: 2,
      unpaired_right_variants: 1,
    });

    const noReturn = await analyzeSources({
      left: `export default function stop() { throw new Error("stop"); }`,
      right: `export default function stop() { throw new Error("stop"); }`,
    });
    const unknown = compare(...noReturn);
    expect(unknown.changes).toEqual([
      expect.objectContaining({ status: "unknown", path: "" }),
    ]);
  });
});

describe("JavaScript export return-shape container presence", () => {
  it.each(["{}", "[]", "{ nested: 1 }"])(
    "does not report a retained %s container property as removed",
    async (container) => {
      const graphs = await analyzeSources({
        left: 'export default () => ({ type: "item", options: false });',
        right: `export default () => ({ type: "item", options: ${container} });`,
      });
      const result = compare(...graphs);
      const change = result.changes.find(({ path }) => path === "/options");
      expect(change).toMatchObject({
        status: "unknown",
        left: { availability: "literal", value: false },
        right: { availability: "unknown" },
      });
      expect(() =>
        javaScriptExportShapeComparisonResultSchema.parse(result),
      ).not.toThrow();
    },
  );

  it.each(["{}", "[]", "{ nested: 1 }"])(
    "does not report a retained %s container becoming a primitive as added",
    async (container) => {
      const graphs = await analyzeSources({
        left: `export default () => ({ type: "item", options: ${container} });`,
        right: 'export default () => ({ type: "item", options: false });',
      });
      const result = compare(...graphs);
      expect(
        result.changes.find(({ path }) => path === "/options"),
      ).toMatchObject({
        status: "unknown",
        left: { availability: "unknown" },
        right: { availability: "literal", value: false },
      });
    },
  );

  it.each([
    { left: "", right: ", options: false", status: "added" },
    { left: ", options: false", right: "", status: "removed" },
  ])("preserves genuine primitive $status", async ({ left, right, status }) => {
    const graphs = await analyzeSources({
      left: `export default () => ({ type: "item"${left} });`,
      right: `export default () => ({ type: "item"${right} });`,
    });
    expect(compare(...graphs).changes).toEqual([
      expect.objectContaining({ path: "/options", status }),
    ]);
  });

  it("keeps a container transition unknown under incomplete spread coverage", async () => {
    const graphs = await analyzeSources({
      left: 'export default () => ({ type: "item", options: false });',
      right:
        'export default () => ({ type: "item", options: { ...dynamic } });',
    });
    const result = compare(...graphs);
    expect(
      result.changes.find(({ path }) => path === "/options"),
    ).toMatchObject({
      status: "unknown",
      right: { availability: "unknown" },
    });
    expect(result.coverage.status).toBe("partial");
  });

  it("preserves identical container leaves and real primitive changes", async () => {
    const graphs = await analyzeSources({
      left: 'export default () => ({ type: "item", options: {}, enabled: false });',
      right:
        'export default () => ({ type: "item", options: {}, enabled: true });',
    });
    const result = compare(...graphs);
    expect(result.changes).toEqual([
      expect.objectContaining({ path: "/enabled", status: "changed" }),
    ]);
  });
});

describe("JavaScript export return-shape selection", () => {
  it("returns complete candidate, variant, and change inventories", async () => {
    const candidates = await analyzeSources({
      left: `
        export const first = () => ({ type: "first" });
        export const second = () => ({ type: "second" });
        export const third = () => ({ type: "third" });
      `,
      right: `export default () => ({ type: "default" });`,
    });
    const missing = compare(candidates[0], candidates[1], {
      leftExportName: "missing",
    });
    expect(missing.left).toMatchObject({
      status: "missing",
      omitted_candidates: 0,
      candidates: expect.arrayContaining([
        expect.objectContaining({ export_name: "first" }),
        expect.objectContaining({ export_name: "second" }),
        expect.objectContaining({ export_name: "third" }),
      ]),
    });

    const parsers = await sourceOwnedParsers();
    const variants = compare(parsers[0], parsers[1]);
    expect(variants.coverage.omitted_left_variants).toBe(0);
    expect(variants.coverage.omitted_right_variants).toBe(0);

    const changes = await analyzeSources({
      left: `export default () => ({ type: "item" });`,
      right: `export default () => ({ type: "item", depth: 1, level: 2 });`,
    });
    const complete = compare(changes[0], changes[1]);
    expect(complete.summary.added).toBe(2);
    expect(complete.changes).toHaveLength(2);
    expect(complete.coverage.omitted_changes).toBe(0);
  });

  it("refuses an exact selector that resolves to multiple graph nodes", async () => {
    const [left, right] = await analyzeSources({
      left: `export default () => ({ type: "item" });`,
      right: `export default () => ({ type: "item" });`,
    });
    const exported = left.graph.nodes.find((node) =>
      node.observations.some(
        ({ properties }) => properties.semantic_role === "export-binding",
      ),
    );
    if (
      exported === undefined ||
      exported.identity.strategy !== "artifact-local-key"
    )
      throw new Error("Expected one artifact-local export fixture node");
    const duplicate = createJavaScriptApplicationNode({
      kind: exported.kind,
      identity: {
        ...exported.identity,
        key: `${exported.identity.key}:duplicate`,
      },
      observations: exported.observations.map(
        ({ label, properties, evidence }) => ({ label, properties, evidence }),
      ),
    });
    const ambiguousGraph = createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      root_node_ids: left.graph.root_node_ids,
      nodes: [...left.graph.nodes, duplicate],
      edges: left.graph.edges,
      coverage: left.graph.coverage,
      limitations: left.graph.limitations,
    });
    const result = compare({ ...left, graph: ambiguousGraph }, right);

    expect(result.left).toMatchObject({
      status: "ambiguous",
      selected_node_id: null,
      candidates: [expect.any(Object), expect.any(Object)],
    });
    expect(result.changes).toEqual([
      expect.objectContaining({ status: "unknown", path: "" }),
    ]);
  });
});

describe("JavaScript export return-shape projection", () => {
  it("retains more than 64 inferred return fields", async () => {
    const properties = Array.from(
      { length: 70 },
      (_, index) => `field${String(index)}: ${String(index)}`,
    ).join(",");
    const root = await temporaryRoot();
    await writeFile(
      join(root, "parser.mjs"),
      `export const parse = () => ({ ${properties} });`,
    );
    const analyzed = await analyzeGraph(root);
    const returnShape = analyzed.graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties: value }) =>
          value.semantic_role === "export-return-shapes",
      );

    const shapes = returnShape?.properties.static_return_shapes;
    expect(Array.isArray(shapes)).toBe(true);
    if (!Array.isArray(shapes)) throw new TypeError("Missing return shapes");
    const firstShape = shapes[0];
    if (
      firstShape === null ||
      typeof firstShape !== "object" ||
      Array.isArray(firstShape)
    )
      throw new TypeError("Missing first return shape");
    expect(firstShape.fields).toHaveLength(70);
    expect(returnShape?.properties.return_shape_coverage).toMatchObject({
      omitted_fields: 0,
      projection_complete: true,
    });
  });

  it("returns every source property within the supplied inputs", async () => {
    const properties = [
      'a_type: "item"',
      ...Array.from(
        { length: 70 },
        (_, index) => `field${String(index)}: ${String(index)}`,
      ),
    ].join(",");
    const [left, right] = await analyzeSources({
      left: `export default () => ({ ${properties} });`,
      right: `export default () => ({ ${properties} });`,
    });
    const result = compare(left, right);

    expect(result.coverage.status).toBe("complete-within-inputs");
    expect(result.coverage.left_omitted_fields).toBe(0);
    expect(result.coverage.right_omitted_fields).toBe(0);
  });
});

type GraphSource = Awaited<ReturnType<typeof analyzeGraph>>;

const compare = (
  left: GraphSource,
  right: GraphSource,
  options: {
    readonly leftExportName?: string;
    readonly rightExportName?: string;
  } = {},
) =>
  compareJavaScriptExportShapes({
    left: {
      evidenceId: left.evidence.evidence_id,
      graph: left.graph,
      modulePath: "parser.mjs",
      exportName: options.leftExportName ?? "default",
    },
    right: {
      evidenceId: right.evidence.evidence_id,
      graph: right.graph,
      modulePath: "parser.mjs",
      exportName: options.rightExportName ?? "default",
    },
  });

const analyzeGraph = async (root: string) => {
  const result = await analyzeJavaScriptApplication({
    input_path: root,
  });
  if (!result.ok) throw result.error;
  return parseApplicationGraphEvidence(result.value);
};

const analyzeSources = async (sources: {
  readonly left: string;
  readonly right: string;
}): Promise<[GraphSource, GraphSource]> => {
  const root = await temporaryRoot();
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  await Promise.all([
    writeFile(join(leftRoot, "parser.mjs"), sources.left),
    writeFile(join(rightRoot, "parser.mjs"), sources.right),
  ]);
  return Promise.all([analyzeGraph(leftRoot), analyzeGraph(rightRoot)]);
};

const sourceOwnedParsers = async (): Promise<[GraphSource, GraphSource]> => {
  const root = await temporaryRoot();
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  await Promise.all([
    copyFile(
      resolve("tests/fixtures/replay/parser.mjs"),
      join(leftRoot, "parser.mjs"),
    ),
    copyFile(
      resolve("tests/fixtures/replay/parser-v2.mjs"),
      join(rightRoot, "parser.mjs"),
    ),
  ]);
  return Promise.all([analyzeGraph(leftRoot), analyzeGraph(rightRoot)]);
};

const temporaryRoot = (): Promise<string> =>
  createTestTempDirectory("rea-export-shapes-");
