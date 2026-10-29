import { parse } from "@babel/parser";
import { traverseFast, type Node } from "@babel/types";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

/** String specifiers only, matching scripts/lib/module-boundaries.mjs. */
const literalValue = (node: Node | null | undefined): string | undefined => {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

const importSpecifier = (node: Node): string | undefined => {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "TSImportType":
      return literalValue(node.source);
    case "ExportNamedDeclaration":
    case "ImportExpression":
      return literalValue(node.source);
    case "TSImportEqualsDeclaration":
      return node.moduleReference.type === "TSExternalModuleReference"
        ? literalValue(node.moduleReference.expression)
        : undefined;
    default:
      return undefined;
  }
};

/** Import and re-export specifiers, using the same Babel nodes as the module-boundary guard. */
export const relativeSpecifiers = (source: string): readonly string[] => {
  const specifiers: string[] = [];
  const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
  traverseFast(tree, (node) => {
    const specifier = importSpecifier(node);
    if (specifier?.startsWith(".") === true) specifiers.push(specifier);
  });
  return specifiers;
};

/**
 * Cycles that already existed outside the analysis-view hub. Membership is
 * exact so a new edge cannot hide inside the allow-list.
 */
const allowedCycles = [
  [
    "StateRecordChronology.ts",
    "environmentStateListQuery.ts",
    "environmentStateRules.ts",
    "environmentStateWriteRules.ts",
  ],
  ["environmentStateGate.ts", "environmentStateListFacts.ts"],
  ["environmentStateWriteAddress.ts", "environmentStateWriteEffects.ts"],
];

const productionFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...productionFiles(path));
    else if (name.endsWith(".ts") && !name.includes(".test.")) files.push(path);
  }
  return files;
};

const importGraph = (): Map<string, Set<string>> => {
  const files = new Set(
    productionFiles(root).map((path) => relative(root, path)),
  );
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const edges = new Set<string>();
    for (const spec of relativeSpecifiers(source)) {
      const resolved = resolve(dirname(join(root, file)), spec).replace(
        /\.js$/,
        ".ts",
      );
      const target = relative(root, resolved);
      if (files.has(target)) edges.add(target);
    }
    graph.set(file, edges);
  }
  return graph;
};

const stronglyConnected = (
  graph: Map<string, Set<string>>,
): readonly (readonly string[])[] => {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? index, low.get(next) ?? index));
      } else if (onStack.has(next)) {
        low.set(
          node,
          Math.min(low.get(node) ?? index, indices.get(next) ?? index),
        );
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member = "";
      while (member !== node) {
        member = stack.pop() ?? node;
        onStack.delete(member);
        component.push(member);
      }
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort(
    (left, right) =>
      right.length - left.length || left.join().localeCompare(right.join()),
  );
};

describe("analysis view import cycles", () => {
  it("reads side-effect imports and ignores import-like text", () => {
    expect(
      relativeSpecifiers(`
        // from "./commented.js"
        /* import "./block-comment.js"; */
        const text = "from './string.js'";
        import "./side-effect.js";
        import { value } from "./named.js";
        export { value as again } from "./reexported.js";
        const loaded = import("./dynamic.js");
      `),
    ).toEqual([
      "./side-effect.js",
      "./named.js",
      "./reexported.js",
      "./dynamic.js",
    ]);
  });

  it("keeps projectors from importing the request and result hub", () => {
    const cycles = stronglyConnected(importGraph()).map((cycle) =>
      cycle.join("\n"),
    );
    expect(cycles).toEqual(
      allowedCycles.map((cycle) => [...cycle].sort().join("\n")),
    );
  });
});
