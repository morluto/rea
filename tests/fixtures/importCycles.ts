import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { readImportSpecifiers } from "../../scripts/lib/import-specifiers.mjs";

const relativeSpecifiers = (source: string): readonly string[] =>
  readImportSpecifiers(source)
    .map(({ specifier }) => specifier)
    .filter((specifier) => specifier.startsWith("."));

const productionFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...productionFiles(path));
    else if (
      name.endsWith(".ts") &&
      !/\.(?:test|spec)\.ts$/u.test(name) &&
      !name.endsWith(".fixture.ts")
    )
      files.push(path);
  }
  return files;
};

const importGraph = (root: string): Map<string, Set<string>> => {
  const files = new Set(
    productionFiles(root).map((path) => relative(root, path)),
  );
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const edges = new Set<string>();
    for (const spec of relativeSpecifiers(source)) {
      const resolved = fileURLToPath(
        new URL(spec, pathToFileURL(join(root, file))),
      ).replace(/\.js$/, ".ts");
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
      if (component.length > 1 || graph.get(node)?.has(node) === true)
        components.push(component.sort());
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

/** Check cycle membership and internal edges against the subsystem's allowance. */
export const expectImportCycles = (
  root: string,
  allowedCycles: readonly (readonly string[])[],
  allowedCycleEdges: readonly string[],
): void => {
  const graph = importGraph(root);
  const cycles = stronglyConnected(graph).map((cycle) => cycle.join("\n"));
  expect(cycles).toEqual(
    allowedCycles.map((cycle) => [...cycle].sort().join("\n")),
  );
  const internalEdges = allowedCycles.flatMap((cycle) =>
    cycle.flatMap((source) =>
      [...(graph.get(source) ?? [])]
        .filter((target) => cycle.includes(target))
        .map((target) => `${source} -> ${target}`),
    ),
  );
  expect(internalEdges.sort()).toEqual(allowedCycleEdges);
};
