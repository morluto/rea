import * as t from "@babel/types";
import { expect, it } from "vitest";

import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

it("preserves source-tree enter/exit order and detached ancestor snapshots", () => {
  const parsed = parseJavaScriptSource("const answer = first + second;");
  if (parsed === null)
    throw new TypeError("Expected a parsed JavaScript fixture");
  const visits: string[] = [];
  const snapshots: (readonly t.Node[])[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node, parent, readAncestors) => {
      visits.push(`enter:${node.type}`);
      const ancestors = readAncestors();
      expect(ancestors.at(-1) ?? null).toBe(parent);
      if (t.isIdentifier(node)) snapshots.push(ancestors);
    },
    exit: (node) => visits.push(`exit:${node.type}`),
  });
  expect(visits).toEqual([
    "enter:Program",
    "enter:VariableDeclaration",
    "enter:VariableDeclarator",
    "enter:Identifier",
    "exit:Identifier",
    "enter:BinaryExpression",
    "enter:Identifier",
    "exit:Identifier",
    "enter:Identifier",
    "exit:Identifier",
    "exit:BinaryExpression",
    "exit:VariableDeclarator",
    "exit:VariableDeclaration",
    "exit:Program",
  ]);
  expect(snapshots.map((nodes) => nodes.map(({ type }) => type))).toEqual([
    ["Program", "VariableDeclaration", "VariableDeclarator"],
    [
      "Program",
      "VariableDeclaration",
      "VariableDeclarator",
      "BinaryExpression",
    ],
    [
      "Program",
      "VariableDeclaration",
      "VariableDeclarator",
      "BinaryExpression",
    ],
  ]);
});
