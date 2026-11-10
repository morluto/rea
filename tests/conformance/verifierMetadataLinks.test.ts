import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  importSpecifier,
  readImportSpecifiers,
} from "../../scripts/lib/import-specifiers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const syntax = (source: string) =>
  parse(source, { sourceType: "module", plugins: ["typescript"] });

const exportedValues = (tree: ReturnType<typeof syntax>) => {
  const names = new Set<string>();
  for (const node of tree.program.body) {
    if (!t.isExportNamedDeclaration(node) || node.exportKind === "type")
      continue;
    const declaration = node.declaration;
    if (t.isVariableDeclaration(declaration)) {
      for (const binding of declaration.declarations)
        if (t.isIdentifier(binding.id)) names.add(binding.id.name);
    } else if (
      (t.isFunctionDeclaration(declaration) ||
        t.isClassDeclaration(declaration)) &&
      declaration.id != null
    )
      names.add(declaration.id.name);
    for (const binding of node.specifiers)
      if (!t.isExportSpecifier(binding) || binding.exportKind !== "type")
        names.add(
          t.isIdentifier(binding.exported)
            ? binding.exported.name
            : binding.exported.value,
        );
  }
  return names;
};

/** Derive migrated metadata symbols from their current source owners. */
const metadataSymbols = async () => {
  const pending = [resolve(root, "src/composition/capabilityDeclarations.ts")];
  const seen = new Set<string>();
  const symbols = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const name of exportedValues(syntax(source))) symbols.add(name);
    for (const fact of readImportSpecifiers(source))
      if (!fact.typeOnly && fact.specifier.startsWith("."))
        pending.push(
          resolve(dirname(file), fact.specifier).replace(/\.js$/u, ".ts"),
        );
  }
  return symbols;
};

const literal = (node: t.Node | null | undefined): string | undefined =>
  t.isStringLiteral(node)
    ? node.value
    : t.isTemplateLiteral(node) && node.expressions.length === 0
      ? (node.quasis[0]?.value.cooked ?? undefined)
      : undefined;

/** Interpret only the literal/fileURL/join patterns used by packaged verifiers. */
const compiledReference = (
  node: t.Node | null | undefined,
): string | undefined => {
  const value = literal(node);
  if (value !== undefined) return value;
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee))
    return undefined;
  if (node.callee.name === "pathToFileURL")
    return compiledReference(node.arguments[0]);
  if (node.callee.name === "join")
    return node.arguments
      .map(literal)
      .find((part) => part?.startsWith("dist/"));
  return undefined;
};

const dynamicSource = (node: t.Node | null | undefined): t.Node | undefined => {
  if (t.isAwaitExpression(node)) return dynamicSource(node.argument);
  if (t.isImportExpression(node)) return node.source;
  return undefined;
};

interface MetadataLink {
  readonly name: string;
  readonly reference: string | undefined;
  readonly line: number;
}

/** Static linking only: no verifier main or provider implementation is executed. */
const metadataLinks = (source: string, names: ReadonlySet<string>) => {
  const tree = syntax(source);
  const links: MetadataLink[] = [];
  const namespaces = new Map<string, string | undefined>();
  const add = (name: string, reference: string | undefined, node: t.Node) => {
    if (names.has(name))
      links.push({ name, reference, line: node.loc?.start.line ?? 1 });
  };
  t.traverseFast(tree, (node) => {
    if (t.isImportDeclaration(node) && node.importKind !== "type") {
      const reference = importSpecifier(node);
      for (const binding of node.specifiers) {
        if (t.isImportSpecifier(binding) && binding.importKind !== "type")
          add(
            t.isIdentifier(binding.imported)
              ? binding.imported.name
              : binding.imported.value,
            reference,
            node,
          );
        else if (t.isImportNamespaceSpecifier(binding))
          namespaces.set(binding.local.name, reference);
      }
    }
    if (!t.isVariableDeclarator(node)) return;
    const target = dynamicSource(node.init);
    if (target === undefined) return;
    const reference = compiledReference(target);
    if (t.isIdentifier(node.id)) namespaces.set(node.id.name, reference);
    if (t.isObjectPattern(node.id))
      for (const property of node.id.properties)
        if (t.isObjectProperty(property)) {
          const name = t.isIdentifier(property.key)
            ? property.key.name
            : literal(property.key);
          if (name !== undefined) add(name, reference, node);
        }
  });
  t.traverseFast(tree, (node) => {
    if (
      !t.isMemberExpression(node) ||
      !t.isIdentifier(node.object) ||
      !namespaces.has(node.object.name)
    )
      return;
    const name =
      !node.computed && t.isIdentifier(node.property)
        ? node.property.name
        : literal(node.property);
    if (name !== undefined) add(name, namespaces.get(node.object.name), node);
  });
  return links;
};

const scriptsBelow = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? scriptsBelow(path)
        : Promise.resolve(/\.(?:mjs|js)$/u.test(path) ? [path] : []);
    }),
  );
  return nested.flat();
};

const linkFailures = async (
  file: string,
  source: string,
  symbols: ReadonlySet<string>,
) => {
  const failures: string[] = [];
  const links = metadataLinks(source, symbols);
  for (const { name, reference, line } of links) {
    if (reference === undefined) {
      failures.push(
        `${relative(root, file)}:${line}: unresolved ${name} import`,
      );
      continue;
    }
    const target = reference.startsWith("file:")
      ? fileURLToPath(reference)
      : reference.startsWith("dist/")
        ? resolve(root, reference)
        : resolve(dirname(file), reference);
    const compiled = relative(root, target).replaceAll("\\", "/");
    if (!compiled.startsWith("dist/")) continue;
    const sourcePath = resolve(
      root,
      compiled.replace(/^dist\//u, "src/"),
    ).replace(/\.js$/u, ".ts");
    const exports = exportedValues(syntax(await readFile(sourcePath, "utf8")));
    if (!exports.has(name))
      failures.push(
        `${relative(root, file)}:${line}: ${compiled} has no ${name} export`,
      );
  }
  return { failures, checked: links.length };
};

it("links verifier metadata exports through static, namespace and packaged dynamic imports", async () => {
  const symbols = await metadataSymbols();
  const files = [
    ...(await scriptsBelow(resolve(root, "scripts"))),
    ...(await scriptsBelow(resolve(root, "tests/fixtures"))),
  ];
  const failures: string[] = [];
  let checked = 0;
  for (const file of files) {
    const result = await linkFailures(
      file,
      await readFile(file, "utf8"),
      symbols,
    );
    failures.push(...result.failures);
    checked += result.checked;
  }
  expect(checked).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

it.each([
  'import { HOPPER_PROVIDER_IDENTITY } from "../dist/hopper/HopperProviderCapabilities.js";',
  'const { GHIDRA_OPERATIONS } = await import(pathToFileURL(join(packageRoot, "dist/ghidra/GhidraProviderCapabilities.js")));',
  'const metadata = await import("../dist/ghidra/GhidraProviderCapabilities.js"); metadata.GHIDRA_OPERATIONS;',
])(
  "detects a metadata consumer whose old owner no longer exports its requirement: %s",
  async (source) => {
    const result = await linkFailures(
      resolve(root, "scripts/authored-negative-control.mjs"),
      source,
      await metadataSymbols(),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      / has no (?:HOPPER_PROVIDER_IDENTITY|GHIDRA_OPERATIONS) export$/u,
    );
  },
);
