import * as t from "@babel/types";
import { describe, expect, it } from "vitest";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  javaScriptClassifiedNodeTypes,
  javaScriptExecutions,
  javaScriptTypeOnlyAliases,
} from "./javascriptSemanticExecutionPoints.js";
import { childNodes } from "./javascriptSemanticTraversal.js";
import { semanticPropertyReadSources } from "./javascriptSemanticIterationSources.js";

const installedNodeTypes = [
  ...new Set([...Object.keys(t.VISITOR_KEYS), ...Object.keys(t.NODE_FIELDS)]),
].sort();

const typeOnly = new Set<string>(
  javaScriptTypeOnlyAliases.flatMap(
    (alias) => t.FLIPPED_ALIAS_KEYS[alias] ?? [],
  ),
);

describe("JavaScript execution classification", () => {
  it("classifies every installed Babel node type", () => {
    const classified = new Set(javaScriptClassifiedNodeTypes());
    const unclassified = installedNodeTypes.filter(
      (type) =>
        !classified.has(type) &&
        (!typeOnly.has(type) || type === "EnumDeclaration"),
    );
    expect(unclassified).toEqual([]);
  });

  it("names no node type the installed Babel version lacks", () => {
    const known = new Set([
      ...installedNodeTypes,
      ...Object.keys(t.DEPRECATED_KEYS),
    ]);
    expect(
      javaScriptClassifiedNodeTypes().filter((type) => !known.has(type)),
    ).toEqual([]);
  });

  it("treats a node type it does not know as code that may run", () => {
    const future = { type: "FutureExpression" } as unknown as t.Node;
    expect(javaScriptExecutions(future, null)).toMatchObject([
      { kind: "unsupported-syntax", node: future },
    ]);
  });
});

const parsed = (source: string): t.Program => {
  const file = parseJavaScriptSource(source, "classification.jsx");
  if (file === null) throw new Error(`Fixture did not parse: ${source}`);
  return file.program;
};

/** Kinds per node type for every node in one parsed program. */
const kindsByType = (source: string): Map<string, string[]> => {
  const kinds = new Map<string, string[]>();
  const pending: { node: t.Node; parent: t.Node | null }[] = [
    { node: parsed(source), parent: null },
  ];
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    for (const { kind } of javaScriptExecutions(node, parent))
      kinds.set(node.type, [...(kinds.get(node.type) ?? []), kind]);
    for (const child of childNodes(node))
      pending.push({ node: child, parent: node });
  }
  return kinds;
};

it.each([
  ["value === other; !value; typeof value; void value; value && other;", {}],
  ["value + other;", { BinaryExpression: ["coercion"] }],
  ["`${value}`;", { TemplateLiteral: ["coercion"] }],
  ["tag`${value}`;", { TaggedTemplateExpression: ["tagged-template"] }],
  ["value.key;", { MemberExpression: ["property-read"] }],
  [
    "value.key = 1;",
    {
      AssignmentExpression: ["property-write"],
      MemberExpression: ["property-read"],
    },
  ],
  ["binding = value;", {}],
  ["const { key } = value;", { VariableDeclarator: ["destructuring"] }],
  ["const [first] = value;", { VariableDeclarator: ["iteration"] }],
  ["const copy = [...value];", { SpreadElement: ["iteration"] }],
  ["const copy = { ...value };", { SpreadElement: ["property-copy"] }],
  ["for (const item of value);", { ForOfStatement: ["iteration"] }],
  ["for (const key in value);", { ForInStatement: ["enumeration"] }],
  [
    "try { throw source; } catch ({ value }) {}",
    { CatchClause: ["destructuring"] },
  ],
  ["try { throw source; } catch ([value]) {}", { CatchClause: ["iteration"] }],
  ["async function f() { await value; }", { AwaitExpression: ["thenable"] }],
  ["function* f() { yield value; }", { YieldExpression: ["suspension"] }],
  ["function* f() { yield* value; }", { YieldExpression: ["iteration"] }],
  ["{ using resource = value; }", { VariableDeclarator: ["disposal"] }],
  ["class C extends Base {}", { ClassDeclaration: ["class-definition"] }],
  [
    "@decorate class C {}",
    { ClassDeclaration: ["class-definition"], Decorator: ["decorator"] },
  ],
  ["import(value);", { ImportExpression: ["dynamic-import"] }],
  ["with (value) key;", { WithStatement: ["dynamic-scope"] }],
  ["<Element prop={value} />;", { JSXElement: ["jsx-element"] }],
  ['import "side-effect";', { ImportDeclaration: ["module-evaluation"] }],
  ["new Factory(value);", { NewExpression: ["construction"] }],
  ["call(value);", { CallExpression: ["call"] }],
])("classifies %s", (source, expected) => {
  expect(Object.fromEntries(kindsByType(source))).toEqual(expected);
});

it("exposes the enumerated object", () => {
  const node = parsed("for (const key in value);").body[0];
  if (!t.isForInStatement(node)) throw new Error("Expected for-in statement");
  expect(javaScriptExecutions(node, null)).toContainEqual(
    expect.objectContaining({ kind: "enumeration", operands: [node.right] }),
  );
});

it.each(["!trigger", "typeof trigger", "void trigger", "trigger === 1"])(
  "retains catch property reads when %s may invoke a global accessor",
  (expression) => {
    const statement = parsed(`try { ${expression}; } catch ({ value }) {}`)
      .body[0];
    if (!t.isTryStatement(statement) || statement.handler == null)
      throw new Error("Expected catch clause");
    expect(semanticPropertyReadSources(statement.handler, statement)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projection: expect.arrayContaining(["value"]),
        }),
      ]),
    );
  },
);
