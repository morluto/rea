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
