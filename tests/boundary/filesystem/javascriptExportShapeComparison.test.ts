import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { compareJavaScriptExportShapes } from "../../../src/domain/javascript/javascriptExportShapeComparison.js";
import {
  javaScriptExportShapeComparisonResultSchema,
  projectedExportReturnShapesSchema,
} from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
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
        presence: { left: "absent", right: "present" },
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
      expect.objectContaining({
        status: "unknown",
        path: "/depth",
        presence: { left: "unknown-coverage", right: "present" },
      }),
    ]);
    expect(result.coverage.status).toBe("partial");
  });

  it("orders multiple changed paths deterministically across Unicode names", async () => {
    const graphs = await analyzeSources({
      left: `export default () => ({ type: "item", zeta: 1, alpha: 1, "éclair": 1 });`,
      right: `export default () => ({ type: "item", zeta: 2, alpha: 2, "éclair": 2 });`,
    });
    const first = compare(...graphs);
    const second = compare(...graphs);

    expect(new Set(first.changes.map(({ path }) => path))).toEqual(
      new Set(["/alpha", "/zeta", "/éclair"]),
    );
    expect(first.changes).toEqual(second.changes);
    expect(first.comparison_id).toBe(second.comparison_id);
  });
});

describe("JavaScript export return-shape pairing limits", () => {
  it.each([
    { presence: "absent", side: "left" },
    { presence: "unknown-coverage", side: "left" },
    { presence: "absent", side: "right" },
    { presence: "unknown-coverage", side: "right" },
  ] as const)(
    "does not pair an inline $side discriminant whose presence is $presence",
    async ({ presence, side }) => {
      const [left, right] = await analyzeSources({
        left: 'export default () => ({ kind: "result", count: 1 });',
        right: 'export default () => ({ kind: "result", total: 2 });',
      });
      const selected = side === "left" ? left : right;
      const graph = createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: selected.graph.root_node_ids,
        edges: selected.graph.edges,
        coverage: selected.graph.coverage,
        limitations: selected.graph.limitations,
        nodes: selected.graph.nodes.map((node) =>
          createJavaScriptApplicationNode({
            kind: node.kind,
            identity: node.identity,
            observations: node.observations.map(
              ({ label, properties, evidence }) => ({
                label,
                evidence,
                properties:
                  properties.semantic_role !== "export-return-shapes"
                    ? properties
                    : {
                        ...properties,
                        static_return_shapes: projectedExportReturnShapesSchema
                          .parse(properties)
                          .static_return_shapes.map((shape) => ({
                            ...shape,
                            fields: shape.fields.map((field) =>
                              field.path === "/kind"
                                ? { ...field, presence }
                                : field,
                            ),
                          })),
                      },
              }),
            ),
          }),
        ),
      });
      const result =
        side === "left"
          ? compare({ ...left, graph }, right)
          : compare(left, { ...right, graph });
      expect(result.coverage).toMatchObject({
        status: "partial",
        paired_variants: 0,
        unpaired_left_variants: 1,
        unpaired_right_variants: 1,
      });
      expect(result.changes).toHaveLength(2);
      expect(
        result.changes.every(
          ({ status, discriminant }) =>
            status === "unknown" && discriminant === null,
        ),
      ).toBe(true);
      expect(
        result.property_inventories.every(
          ({ paired, discriminant }) => !paired && discriminant === null,
        ),
      ).toBe(true);
    },
  );

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

describe("JavaScript export return-shape uncertain presence", () => {
  it.each([false, true])(
    "keeps deleted property presence unknown (reversed: %s)",
    async (reversed) => {
      const plain = 'export default () => ({ kind: "result" });';
      const mutated = `export default function make() {
      const result = { kind: "result", count: 1 };
      delete result.count;
      return result;
    }`;
      const graphs = await analyzeSources({
        left: reversed ? mutated : plain,
        right: reversed ? plain : mutated,
      });
      const result = compare(...graphs);
      expect(result.changes).toContainEqual(
        expect.objectContaining({
          path: "/count",
          status: "unknown",
          presence: reversed
            ? { left: "unknown-coverage", right: "absent" }
            : { left: "absent", right: "unknown-coverage" },
        }),
      );
      expect(
        inventoryProperties(result, reversed ? "left" : "right", 0),
      ).not.toContain("/count");
      expect(result.summary.added + result.summary.removed).toBe(0);
      expect(result.coverage.status).toBe("partial");
    },
  );

  it("excludes array holes while preserving observed unknown elements", async () => {
    const holes = 'export default () => ({ kind: "result", items: [,] });';
    const empty = await analyzeSources({
      left: holes,
      right: 'export default () => ({ kind: "result", items: [] });',
    });
    const result = compare(...empty);
    expect(result.coverage.status).toBe("complete-within-inputs");
    expect(inventoryProperties(result, "left", 0)).not.toContain("/items/0");
    expect(result.changes.some(({ path }) => path === "/items/0")).toBe(false);
    const filled = await analyzeSources({
      left: holes,
      right: 'export default () => ({ kind: "result", items: [call()] });',
    });
    expect(compare(...filled).changes).toContainEqual(
      expect.objectContaining({
        path: "/items/0",
        status: "added",
        presence: { left: "absent", right: "present" },
        left: { availability: "absent" },
        right: expect.objectContaining({ availability: "unknown" }),
      }),
    );
  });

  it("retains unpaired inventory locations when the opposite export has no return", async () => {
    const graphs = await analyzeSources({
      left: "export default function f() {}",
      right: `export default function f(flag) {
        if (flag) return { count: call() };
        return { total: call() };
      }`,
    });
    const result = compare(...graphs);
    expect(result.property_inventories).toEqual([
      expect.objectContaining({
        side: "right",
        paired: false,
        variant_index: 0,
        properties: expect.arrayContaining(["/count"]),
        source_range: expect.objectContaining({
          start: expect.objectContaining({ line: 2 }),
        }),
      }),
      expect.objectContaining({
        side: "right",
        paired: false,
        variant_index: 1,
        properties: expect.arrayContaining(["/total"]),
        source_range: expect.objectContaining({
          start: expect.objectContaining({ line: 3 }),
        }),
      }),
    ]);
    expect(() =>
      javaScriptExportShapeComparisonResultSchema.parse(result),
    ).not.toThrow();
  });
});

describe("JavaScript export matching uncertain projections", () => {
  it.each(["delete result.count;", "result.count = query();"])(
    "omits matching uncertain projections after %s",
    async (mutation) => {
      const source = `export default function make() {
        const result = { kind: "result", count: 1 };
        ${mutation}
        return result;
      }`;
      const graphs = await analyzeSources({ left: source, right: source });
      const result = compare(...graphs);
      expect(result.changes).toEqual([]);
      expect(result.summary).toEqual({
        added: 0,
        removed: 0,
        changed: 0,
        unknown: 0,
      });
      expect(result.coverage.status).toBe("partial");
      expect(
        result.property_inventories.every(
          ({ properties }) => !properties.includes("/count"),
        ),
      ).toBe(true);
    },
  );
});

describe("JavaScript export localized mutation uncertainty", () => {
  it.each([
    {
      initializer: '{ kind: "result", count: 1 }',
      mutation: "delete result.count;",
      uncertain: "/count",
      right: '{ kind: "result", total: 1 }',
      added: "/total",
    },
    {
      initializer: '{ kind: "result" }',
      mutation: "result.count = query();",
      uncertain: "/count",
      right: '{ kind: "result", total: 1 }',
      added: "/total",
    },
    {
      initializer: '{ kind: "result" }',
      mutation: "delete result.count;",
      uncertain: "/count",
      right: '{ kind: "result", total: 1 }',
      added: "/total",
    },
    {
      initializer: '{ kind: "result", nested: {} }',
      mutation: "result.nested.count = query();",
      uncertain: "/nested/count",
      right: '{ kind: "result", nested: { total: 1 } }',
      added: "/nested/total",
    },
    {
      initializer: '{ kind: "result", items: [] }',
      mutation: "result.items[1] = query();",
      uncertain: "/items/1",
      right: '{ kind: "result", items: [,,1] }',
      added: "/items/2",
    },
    {
      initializer: '{ kind: "result", items: [] }',
      mutation: "delete result.items[1];",
      uncertain: "/items/1",
      right: '{ kind: "result", items: [,,1] }',
      added: "/items/2",
    },
    {
      initializer: '{ kind: "result", items: [] }',
      mutation: "result.items[1000000000] = query();",
      uncertain: "/items/1000000000",
      right: '{ kind: "result", items: [,,1] }',
      added: "/items/2",
    },
  ])(
    "localizes $mutation without losing sibling absence",
    async ({ initializer, mutation, uncertain, right, added }) => {
      const graphs = await analyzeSources({
        left: `export default function make() {
          const result = ${initializer};
          ${mutation}
          return result;
        }`,
        right: `export default () => (${right});`,
      });
      const result = compare(...graphs);
      expect(result.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: uncertain,
            status: "unknown",
            presence: { left: "unknown-coverage", right: "absent" },
          }),
          expect.objectContaining({
            path: added,
            status: "added",
            presence: { left: "absent", right: "present" },
          }),
        ]),
      );
      expect(result.summary).toEqual({
        added: 1,
        removed: 0,
        changed: 0,
        unknown: 1,
      });
    },
  );
});

describe("JavaScript export property presence boundaries", () => {
  it("rejects return-shape observations that omit required slot presence", async () => {
    const source =
      'export default () => ({ kind: "result", count: flag ? 1 : 2, nested: { enabled: true } });';
    const [left, right] = await analyzeSources({ left: source, right: source });
    const graph = createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      root_node_ids: left.graph.root_node_ids,
      edges: left.graph.edges,
      coverage: left.graph.coverage,
      limitations: left.graph.limitations,
      nodes: left.graph.nodes.map((node) =>
        createJavaScriptApplicationNode({
          kind: node.kind,
          identity: node.identity,
          observations: node.observations.map(
            ({ label, properties, evidence }) => {
              if (properties.semantic_role !== "export-return-shapes")
                return { label, properties, evidence };
              const projection =
                projectedExportReturnShapesSchema.parse(properties);
              return {
                label,
                evidence,
                properties: {
                  ...properties,
                  static_return_shapes: projection.static_return_shapes.map(
                    (shape) => ({
                      ...shape,
                      fields: shape.fields.map(
                        ({ path, state, value, reason }) => ({
                          path,
                          state,
                          value,
                          reason,
                        }),
                      ),
                    }),
                  ),
                },
              };
            },
          ),
        }),
      ),
    });
    for (const sides of [
      [{ ...left, graph }, right],
      [right, { ...left, graph }],
    ] as const) {
      const result = compare(sides[0], sides[1]);
      expect(result.coverage.paired_variants).toBe(0);
      expect([result.left.status, result.right.status]).toContain(
        "unavailable",
      );
      expect(result.changes).toEqual([
        expect.objectContaining({ status: "unknown", path: "" }),
      ]);
      expect(result.coverage.status).toBe("partial");
    }
  });

  it("proves absence beyond literal holes while retaining unknown spread coverage", async () => {
    const right =
      'export default () => ({ kind: "result", items: [,, call()] });';
    const literal = await analyzeSources({
      left: 'export default () => ({ kind: "result", items: [,] });',
      right,
    });
    const result = compare(...literal);
    expect(result.changes).toEqual([
      expect.objectContaining({
        path: "/items/2",
        status: "added",
        presence: { left: "absent", right: "present" },
      }),
    ]);
    expect(result.coverage.status).toBe("complete-within-inputs");
    const spread = await analyzeSources({
      left: 'export default () => ({ kind: "result", items: [, ...rest] });',
      right,
    });
    expect(compare(...spread).changes).toContainEqual(
      expect.objectContaining({
        path: "/items/2",
        status: "unknown",
        presence: { left: "unknown-coverage", right: "present" },
      }),
    );
  });

  it("excludes the return root but retains empty property names and nested containers", async () => {
    const source =
      'export default () => ({ kind: "result", "": call(), options: {} });';
    const graphs = await analyzeSources({ left: source, right: source });
    const result = compare(...graphs);
    expect(inventoryProperties(result, "left", 0)).toEqual([
      "/",
      "/kind",
      "/options",
    ]);
    expect(result.property_inventories[0]?.property_coverage).toContainEqual({
      path: "",
      status: "complete",
    });
  });
});

describe("JavaScript export return-shape property presence", () => {
  it("lists observed names without pairing untagged search variants", async () => {
    const graphs = await analyzeSources(
      {
        left: untaggedSearchSource("count"),
        right: untaggedSearchSource("total"),
      },
      "search.js",
    );
    const first = compare(...graphs, {
      modulePath: "search.js",
      leftExportName: "search",
      rightExportName: "search",
    });
    const second = compare(...graphs, {
      modulePath: "search.js",
      leftExportName: "search",
      rightExportName: "search",
    });

    expect(first.comparison_id).toBe(second.comparison_id);
    expect(first.coverage).toMatchObject({
      paired_variants: 0,
      unpaired_left_variants: 1,
      unpaired_right_variants: 1,
    });
    expect(first.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unknown: 2,
    });
    expect(
      first.changes.every(({ discriminant }) => discriminant === null),
    ).toBe(true);
    expect(inventoryProperties(first, "left", 0)).toEqual(
      expect.arrayContaining(["/count", "/matches"]),
    );
    expect(inventoryProperties(first, "right", 0)).toEqual(
      expect.arrayContaining(["/matches", "/query", "/total"]),
    );
    expect(inventoryProperties(first, "left", 0)).not.toEqual(
      inventoryProperties(first, "right", 0),
    );
  });

  it("reports presence-only added and removed names for tagged search variants", async () => {
    const graphs = await analyzeSources(
      {
        left: taggedSearchSource({ count: true }),
        right: taggedSearchSource({ total: true, query: true }),
      },
      "search.js",
    );
    const first = compare(...graphs, {
      modulePath: "search.js",
      leftExportName: "search",
      rightExportName: "search",
    });
    const second = compare(...graphs, {
      modulePath: "search.js",
      leftExportName: "search",
      rightExportName: "search",
    });

    expect(first.comparison_id).toBe(second.comparison_id);
    expect(() =>
      javaScriptExportShapeComparisonResultSchema.parse(first),
    ).not.toThrow();
    expect(first.coverage.paired_variants).toBe(1);
    expect(first.summary.added).toBe(2);
    expect(first.summary.removed).toBe(1);
    expect(
      first.changes.filter(({ path }) =>
        ["/count", "/total", "/query"].includes(path),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "removed",
          path: "/count",
          presence: { left: "present", right: "absent" },
          left: expect.objectContaining({ availability: "unknown" }),
          right: { availability: "absent" },
        }),
        expect.objectContaining({
          status: "added",
          path: "/total",
          presence: { left: "absent", right: "present" },
          left: { availability: "absent" },
          right: expect.objectContaining({ availability: "unknown" }),
        }),
        expect.objectContaining({
          status: "added",
          path: "/query",
          presence: { left: "absent", right: "present" },
          left: { availability: "absent" },
          right: expect.objectContaining({ availability: "unknown" }),
        }),
      ]),
    );
    expect(
      first.changes.some(
        ({ path, status }) =>
          ["/count", "/total", "/query"].includes(path) && status === "unknown",
      ),
    ).toBe(false);
    expect(inventoryProperties(first, "left", 0)).toEqual(
      expect.arrayContaining(["/count", "/kind", "/matches"]),
    );
    expect(inventoryProperties(first, "right", 0)).toEqual(
      expect.arrayContaining(["/kind", "/matches", "/query", "/total"]),
    );
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
    readonly modulePath?: string;
    readonly leftExportName?: string;
    readonly rightExportName?: string;
  } = {},
) =>
  compareJavaScriptExportShapes({
    left: {
      evidenceId: left.evidence.evidence_id,
      graph: left.graph,
      modulePath: options.modulePath ?? "parser.mjs",
      exportName: options.leftExportName ?? "default",
    },
    right: {
      evidenceId: right.evidence.evidence_id,
      graph: right.graph,
      modulePath: options.modulePath ?? "parser.mjs",
      exportName: options.rightExportName ?? "default",
    },
  });

const analyzeGraph = async (root: string) => {
  const result = await analyzeJavaScriptApplication({
    input_path: root,
  });
  if (!result.ok) throw result.error;
  const parsed = parseApplicationGraphEvidence(result.value);
  if (!parsed.ok) throw new Error("Analysis Evidence must parse");
  return parsed.value;
};

const analyzeSources = async (
  sources: {
    readonly left: string;
    readonly right: string;
  },
  fileName = "parser.mjs",
): Promise<[GraphSource, GraphSource]> => {
  const root = await temporaryRoot();
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  await Promise.all([
    writeFile(join(leftRoot, fileName), sources.left),
    writeFile(join(rightRoot, fileName), sources.right),
  ]);
  return Promise.all([analyzeGraph(leftRoot), analyzeGraph(rightRoot)]);
};

const inventoryProperties = (
  result: ReturnType<typeof compareJavaScriptExportShapes>,
  side: "left" | "right",
  variantIndex: number,
): string[] => {
  const inventory = result.property_inventories.find(
    (entry) => entry.side === side && entry.variant_index === variantIndex,
  );
  if (inventory === undefined)
    throw new Error(
      `Missing ${side} property inventory ${String(variantIndex)}`,
    );
  return inventory.properties;
};

const untaggedSearchSource = (countKey: "count" | "total"): string =>
  countKey === "count"
    ? `
        export function search(items, q) {
          const matches = items.filter((item) => item.includes(q));
          return { matches, count: matches.length };
        }
      `
    : `
        export function search(items, q) {
          const matches = items.filter((item) => item.includes(q));
          return { matches, total: matches.length, query: String(q) };
        }
      `;

const taggedSearchSource = (fields: {
  readonly count?: boolean;
  readonly total?: boolean;
  readonly query?: boolean;
}): string => {
  const extra = [
    fields.count === true ? "count: matches.length" : null,
    fields.total === true ? "total: matches.length" : null,
    fields.query === true ? "query: String(q)" : null,
  ]
    .filter((field): field is string => field !== null)
    .join(", ");
  return `
    export function search(items, q) {
      const matches = items.filter((item) => item.includes(q));
      return { kind: "results", matches${extra.length > 0 ? `, ${extra}` : ""} };
    }
  `;
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
