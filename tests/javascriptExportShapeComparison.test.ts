import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../src/application/JavaScriptApplicationEvidenceGraph.js";
import { compareJavaScriptExportShapes } from "../src/domain/javascriptExportShapeComparison.js";
import { javaScriptExportShapeComparisonResultSchema } from "../src/domain/javascriptExportShapeComparisonSchemas.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../src/domain/javascriptApplicationGraph.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

describe("JavaScript export return-shape comparison", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("reports exactly the heading depth addition from source-owned parser fixtures", async () => {
    const root = await temporaryRoot(temporary);
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
    expect(first.runtime_validation).toEqual({
      recommended_tool: "run_controlled_replay",
      automatically_started: false,
      required_for: "runtime-semantics",
    });
  });

  it("keeps additions unknown when spread coverage is incomplete", async () => {
    const [left, right] = await analyzeSources(temporary, {
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
      expect.objectContaining({ status: "unknown", path: "/depth" }),
    ]);
    expect(result.coverage.status).toBe("partial");
  });

  it("does not pair ambiguous variants or invent behavior for no-return exports", async () => {
    const ambiguous = await analyzeSources(temporary, {
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

    const noReturn = await analyzeSources(temporary, {
      left: `export default function stop() { throw new Error("stop"); }`,
      right: `export default function stop() { throw new Error("stop"); }`,
    });
    const unknown = compare(...noReturn);
    expect(unknown.changes).toEqual([
      expect.objectContaining({ status: "unknown", path: "" }),
    ]);
  });

  it("reports selector candidates and enforces candidate, variant, and change limits", async () => {
    const candidates = await analyzeSources(temporary, {
      left: `
        export const first = () => ({ type: "first" });
        export const second = () => ({ type: "second" });
        export const third = () => ({ type: "third" });
      `,
      right: `export default () => ({ type: "default" });`,
    });
    const missing = compare(candidates[0], candidates[1], {
      leftExportName: "missing",
      limits: { max_candidate_exports: 1 },
    });
    expect(missing.left).toMatchObject({
      status: "missing",
      omitted_candidates: 2,
      candidates: [expect.objectContaining({ module_path: "parser.mjs" })],
    });
    expect(missing.coverage.status).toBe("truncated");

    const parsers = await sourceOwnedParsers(temporary);
    const variantLimited = compare(parsers[0], parsers[1], {
      limits: { max_return_variants: 1 },
    });
    expect(variantLimited.coverage).toMatchObject({
      status: "truncated",
      omitted_left_variants: 2,
      omitted_right_variants: 2,
    });

    const changes = await analyzeSources(temporary, {
      left: `export default () => ({ type: "item" });`,
      right: `export default () => ({ type: "item", depth: 1, level: 2 });`,
    });
    const changeLimited = compare(changes[0], changes[1], {
      limits: { max_changes: 1 },
    });
    expect(changeLimited.summary.added).toBe(2);
    expect(changeLimited.changes).toHaveLength(1);
    expect(changeLimited.coverage).toMatchObject({
      status: "truncated",
      omitted_changes: 1,
    });
  });

  it("refuses an exact selector that resolves to multiple graph nodes", async () => {
    const [left, right] = await analyzeSources(temporary, {
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
      schema_version: 1,
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

  it("marks graph field projection omissions as truncated", async () => {
    const properties = [
      'a_type: "item"',
      ...Array.from(
        { length: 70 },
        (_, index) => `field${String(index)}: ${String(index)}`,
      ),
    ].join(",");
    const [left, right] = await analyzeSources(temporary, {
      left: `export default () => ({ ${properties} });`,
      right: `export default () => ({ ${properties} });`,
    });
    const result = compare(left, right);

    expect(result.coverage.status).toBe("truncated");
    expect(result.coverage.left_omitted_fields).toBeGreaterThan(0);
    expect(result.coverage.right_omitted_fields).toBeGreaterThan(0);
  });
});

type GraphSource = Awaited<ReturnType<typeof analyzeGraph>>;

const compare = (
  left: GraphSource,
  right: GraphSource,
  options: {
    readonly leftExportName?: string;
    readonly rightExportName?: string;
    readonly limits?: Partial<{
      readonly max_candidate_exports: number;
      readonly max_return_variants: number;
      readonly max_changes: number;
    }>;
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
    limits: {
      max_candidate_exports: options.limits?.max_candidate_exports ?? 100,
      max_return_variants: options.limits?.max_return_variants ?? 128,
      max_changes: options.limits?.max_changes ?? 1_000,
    },
  });

const analyzeGraph = async (root: string) => {
  const authority = await permissionAuthorityForRoot(
    root,
    ["investigation_input"],
    ["investigation_input"],
  );
  const result = await analyzeJavaScriptApplication(authority, {
    input_path: root,
    approved: true,
  });
  if (!result.ok) throw result.error;
  return parseApplicationGraphEvidence(result.value);
};

const analyzeSources = async (
  temporary: string[],
  sources: { readonly left: string; readonly right: string },
): Promise<[GraphSource, GraphSource]> => {
  const root = await temporaryRoot(temporary);
  const leftRoot = join(root, "left");
  const rightRoot = join(root, "right");
  await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
  await Promise.all([
    writeFile(join(leftRoot, "parser.mjs"), sources.left),
    writeFile(join(rightRoot, "parser.mjs"), sources.right),
  ]);
  return Promise.all([analyzeGraph(leftRoot), analyzeGraph(rightRoot)]);
};

const sourceOwnedParsers = async (
  temporary: string[],
): Promise<[GraphSource, GraphSource]> => {
  const root = await temporaryRoot(temporary);
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

const temporaryRoot = async (temporary: string[]): Promise<string> => {
  const root = await createTestTempDirectory("rea-export-shapes-");
  temporary.push(root);
  return root;
};
