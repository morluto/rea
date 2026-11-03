import { describe, expect, it } from "vitest";

import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { SemanticPropertyPathCoverage } from "./javascriptSemanticPropertyPaths.js";
import { childNodes } from "./javascriptSemanticTraversal.js";

const parse = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("fixture source must parse");
  return parsed.program;
};

describe("shared AST child expansion", () => {
  it("reuses the child list for the same node", () => {
    const program = parse("const a = f(b); const c = g(d);");
    const statement = program.body[0]!;

    // Every traversal of the same AST asks for the same children; the expansion is
    // source-derived and cannot change, so a second read is the same array.
    expect(childNodes(statement)).toBe(childNodes(statement));
  });

  it("keeps distinct lists for distinct nodes", () => {
    const program = parse("const a = f(b); const c = g(d);");
    const [first, second] = program.body;

    expect(childNodes(first!)).not.toBe(childNodes(second!));
  });

  it("preserves VISITOR_KEYS order on the shared list", () => {
    const program = parse("x = a ? b : c;");
    const statement = program.body[0]!;

    // An ExpressionStatement has exactly one child; the assignment beneath it expands
    // in VISITOR_KEYS order, which for an assignment is left then right.
    expect(childNodes(statement).map((node) => node.type)).toEqual([
      "AssignmentExpression",
    ]);
    const assignment = childNodes(statement)[0]!;
    expect(childNodes(assignment).map((node) => node.type)).toEqual([
      "Identifier",
      "ConditionalExpression",
    ]);
  });

  it("returns a list the caller can copy before mutating", () => {
    const program = parse("const a = f(b, c);");
    const declaration = program.body[0]!;
    const children = childNodes(declaration);

    // Traversal itself reverses a copy; the shared list must stay untouched.
    const reversed = [...children].reverse();
    expect(reversed.reverse()).toEqual([...children]);
    expect(childNodes(declaration)).toBe(children);
  });
});

describe("property path coverage keys", () => {
  it("keeps contexts distinct from each other and from an absent context", () => {
    const coverage = new SemanticPropertyPathCoverage();

    expect(coverage.retain(["value"], [undefined])).toBe(true);
    // A real context is not the absent context, so the longer path still extends.
    expect(coverage.retain(["value"], ["main"])).toBe(true);
    expect(coverage.retain(["value"], [""])).toBe(true);
    expect(coverage.covers(["value"], [undefined])).toBe(true);
    expect(coverage.covers(["value"], ["main"])).toBe(true);
    expect(coverage.covers(["value"], ["renderer"])).toBe(false);
  });

  it("keeps property names apart even when they contain separators", () => {
    const coverage = new SemanticPropertyPathCoverage();

    // A name carrying the previous JSON encoding's structural characters must not
    // forge a different path: the encoding is length-prefixed, not delimiter-joined.
    expect(coverage.retain(['a","b'], [undefined])).toBe(true);
    expect(coverage.covers(['a","b'], [undefined])).toBe(true);
    expect(coverage.covers(["a"], [undefined])).toBe(false);
    expect(coverage.covers(['a"', "b"], [undefined])).toBe(false);
    expect(coverage.covers(["a,b"], [undefined])).toBe(false);
  });

  it("distinguishes copy selections from plain keys at the same depth", () => {
    const coverage = new SemanticPropertyPathCoverage();

    expect(
      coverage.retain(
        ["items", { excludedKeys: ["0"], startIndex: 1 }],
        [undefined],
      ),
    ).toBe(true);
    // A selection and a plain key are different path slots.
    expect(coverage.covers(["items", "0"], [undefined])).toBe(false);
    expect(coverage.covers(["items", "1"], [undefined])).toBe(true);
    // A selection with a different exclusion list covers different indices.
    expect(
      coverage.covers(
        ["items", { excludedKeys: ["2"], startIndex: 1 }],
        [undefined],
      ),
    ).toBe(false);
  });

  it("retains nested prefixes independently of a later longer path", () => {
    const coverage = new SemanticPropertyPathCoverage();

    expect(coverage.retain(["config", "timeout"], ["main"])).toBe(true);
    expect(coverage.covers(["config"], ["main"])).toBe(false);
    expect(coverage.covers(["config", "timeout", "seconds"], ["main"])).toBe(
      true,
    );
    expect(coverage.covers(["config", "timeout"], ["renderer"])).toBe(false);
  });
});
