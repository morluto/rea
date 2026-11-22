import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const withoutExtension = (path) => path.replace(/\.(?:[cm]?[jt]s)$/u, "");
const arrayExpression = (raw) => {
  let node = raw;
  while (
    node &&
    ["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)
  )
    node = node.expression;
  return node;
};

/** The object of `Object.values(object).flat()`, a static grouping of arrays. */
const flattenedObjectValues = (node) => {
  if (
    node?.type !== "CallExpression" ||
    node.arguments.length !== 0 ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.name !== "flat"
  )
    return undefined;
  const values = node.callee.object;
  return values.type === "CallExpression" &&
    values.arguments.length === 1 &&
    values.callee.type === "MemberExpression" &&
    !values.callee.computed &&
    values.callee.object.type === "Identifier" &&
    values.callee.object.name === "Object" &&
    values.callee.property.name === "values"
    ? values.arguments[0]
    : undefined;
};

/** Read only source composition, never execute the runtime contract catalog. */
export const collectToolCatalogSources = (
  entryPath,
  readSource = (path) => readFileSync(path, "utf8"),
) => {
  const catalogs = new Map();
  const modules = new Map();
  const active = new Set();
  const complete = new Set();
  const moduleFacts = (path) => {
    let facts = modules.get(path);
    if (facts) return facts;
    // Read/parse errors intentionally escape: a broken inventory cannot disable
    // the rule by presenting an empty set of catalog bindings.
    const ast = parse(readSource(path), {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const imports = new Map();
    const exports = new Map();
    const locals = new Map();
    for (const statement of ast.program.body) {
      if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ImportSpecifier")
            imports.set(specifier.local.name, {
              source: statement.source.value,
              name: specifier.imported.name ?? specifier.imported.value,
            });
        }
      }
      const declarations =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declarations?.type === "VariableDeclaration")
        for (const declaration of declarations.declarations)
          if (declaration.id.type === "Identifier") {
            locals.set(declaration.id.name, declaration.init);
            if (statement.type === "ExportNamedDeclaration")
              exports.set(declaration.id.name, declaration.init);
          }
    }
    facts = { imports, exports, locals };
    modules.set(path, facts);
    return facts;
  };
  const visit = (path, name) => {
    const key = JSON.stringify([path, name]);
    if (complete.has(key)) return;
    if (active.has(key))
      throw new Error(`Cyclic tool catalog composition: ${path}#${name}`);
    active.add(key);
    const facts = moduleFacts(path);
    const array = arrayExpression(facts.exports.get(name));
    if (
      array?.type !== "ArrayExpression" &&
      flattenedObjectValues(array) === undefined
    )
      throw new Error(`Expected exported tool catalog array: ${path}#${name}`);
    const source = withoutExtension(path);
    const names = catalogs.get(source) ?? new Set();
    names.add(name);
    catalogs.set(source, names);
    const composition = (raw, localPath = new Set()) => {
      const expression = arrayExpression(raw);
      if (expression?.type === "ArrayExpression") {
        for (const element of expression.elements)
          if (element?.type === "SpreadElement")
            composition(element.argument, localPath);
        return;
      }
      // A static object of groups contributes each property value.
      if (expression?.type === "ObjectExpression") {
        for (const property of expression.properties) {
          if (property.type === "SpreadElement")
            composition(property.argument, localPath);
          else if (property.type === "ObjectProperty")
            composition(property.value, localPath);
          else
            throw new Error(
              `Unsupported catalog group member: ${path}#${name}`,
            );
        }
        return;
      }
      const grouped = flattenedObjectValues(expression);
      if (grouped !== undefined) {
        let object = arrayExpression(grouped);
        const seen = new Set();
        while (object?.type === "Identifier") {
          if (seen.has(object.name) || !facts.locals.has(object.name))
            throw new Error(`Expected static catalog groups: ${path}#${name}`);
          seen.add(object.name);
          object = arrayExpression(facts.locals.get(object.name));
        }
        if (object?.type !== "ObjectExpression")
          throw new Error(`Expected static catalog groups: ${path}#${name}`);
        composition(object, localPath);
        return;
      }
      // Calls such as HOPPER_MEMORY_TOOL_DEFINITIONS.map(official) construct
      // entries locally; they are not imported catalog arrays. Do not execute
      // or infer catalog ownership from arbitrary computed expressions.
      if (expression?.type !== "Identifier") return;
      const binding = facts.imports.get(expression.name);
      if (binding) {
        if (!binding.source.startsWith("."))
          throw new Error(`Expected local catalog module: ${path}#${name}`);
        visit(
          `${withoutExtension(resolve(dirname(path), binding.source))}.ts`,
          binding.name,
        );
        return;
      }
      if (localPath.has(expression.name))
        throw new Error(
          `Cyclic local catalog composition: ${path}#${expression.name}`,
        );
      if (!facts.locals.has(expression.name))
        throw new Error(
          `Unresolved local catalog spread: ${path}#${expression.name}`,
        );
      composition(
        facts.locals.get(expression.name),
        new Set([...localPath, expression.name]),
      );
    };
    composition(array);
    active.delete(key);
    complete.add(key);
  };
  visit(entryPath, "TOOL_CONTRACTS");
  return catalogs;
};
