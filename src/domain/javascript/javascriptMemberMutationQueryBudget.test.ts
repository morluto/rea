import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

// One alias_selections unit admits eight states per query, so these small
// sources outgrow the budget the way a dense bundle outgrows the default.
const tightPrecision = { alias_selections: 1 };

const analyze = (body: string, precision?: typeof tightPrecision) => {
  const ir = analyzeJavaScriptSemantics(
    `export function result(unknown, n) { ${body} }`,
    precision,
  );
  return {
    ir,
    value: onlyCallable(ir, "result").returnSites[0]?.value,
  };
};

const aliasChain = (root: string, length: number): string =>
  Array.from(
    { length },
    (_, index) =>
      `const ${root}${String(index + 1)} = ${index === 0 ? root : `${root}${String(index)}`};`,
  ).join(" ");

describe("a member-mutation query that outgrows its state budget", () => {
  it("completes with a disclosed bound instead of refusing the source", () => {
    const { ir, value } = analyze(
      `const shared = { x: 1 };
       const a = { v: shared, next: null };
       const b = { v: shared, next: a };
       a.next = b;
       let s = a;
       for (let i = 0; i < n; i++) { s = s.next; s.v.x = i; }
       return shared.x;`,
      tightPrecision,
    );
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: expect.arrayContaining(["alias-selections"]),
    });
    // The loop writes shared.x through an alias; it is not the literal 1.
    expect(value?.status).not.toBe("literal");
  });

  it("escapes a value stored by a collapsed write", () => {
    // The store's receiver is reached through more aliases than the budget
    // admits, so the write is answered as an escape of the whole receiver.
    // `y` is then reachable through an object whose members are untracked.
    const body = `const y = { v: 1 };
       const x = {};
       ${aliasChain("x", 12)}
       x12.a = y;
       unknown(x);
       return y.v;`;
    const collapsed = analyze(body, tightPrecision);
    expect(collapsed.ir.coverage.resourceLimits).toContain("alias-selections");
    expect(collapsed.value?.status).not.toBe("literal");
  });

  it("covers a dense cluster once for every query that collapses into it", () => {
    // A hundred calls each pass a member of one cyclic cluster. Their
    // collapsed escapes name no site, so the cluster is walked once and
    // later queries stop where an earlier one already covered.
    const source = `export function result(unknown, n) {
      const shared = { x: 1 };
      const a = { v: shared, next: null };
      const b = { v: shared, next: a };
      const c = { v: shared, next: b };
      a.next = c;
      let s = a; let u = b; let w = c;
      for (let i = 0; i < n; i++) { s = s.next; u = s.next; w = u.next; s = w; }
      ${Array.from(
        { length: 100 },
        (_, index) => `unknown(${["s", "u", "w"][index % 3] ?? "s"}.next);`,
      ).join(" ")}
      return shared.x;
    }`;
    const ir = analyzeJavaScriptSemantics(source, tightPrecision, {
      // Walking the cluster again for each site needs more than 4,000.
      aliasStates: 3_000,
      source: "request",
    });
    expect(ir.coverage.resourceLimits).toContain("alias-selections");
    expect(onlyCallable(ir, "result").returnSites[0]?.value?.status).not.toBe(
      "literal",
    );
  });

  it("follows a long chain of projected aliases without nesting a walk per link", () => {
    // Each link reads a member of the previous object. A collapsed query
    // that started a walk per link overflowed the call stack here.
    const links = 1_500;
    const { ir, value } = analyze(
      `const b0 = { v: 1 };
       ${Array.from(
         { length: links },
         (_, index) =>
           `const a${String(index + 1)} = { p: b${String(index)} }; const b${String(index + 1)} = a${String(index + 1)}.p;`,
       ).join(" ")}
       unknown(b${String(links)});
       return b0.v;`,
      tightPrecision,
    );
    expect(ir.coverage.resourceLimits).toContain("alias-selections");
    expect(value?.status).not.toBe("literal");
  });

  it("leaves a query within its budget exact and undisclosed", () => {
    const { ir, value } = analyze(
      `const y = { v: 1 };
       const x = {};
       ${aliasChain("x", 3)}
       x3.a = y;
       return y.v;`,
    );
    expect(ir.coverage.resourceLimits ?? []).not.toContain("alias-selections");
    expect(value).toMatchObject({ status: "literal", value: 1 });
  });
});
