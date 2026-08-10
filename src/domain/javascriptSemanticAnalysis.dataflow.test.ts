import { it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  onlyCallable,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: dataflow 1", () => {
  it("recovers static object reads, writes, spreads, and destructuring", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { token: "TOKEN", count: 1 };
      const { token } = source;
      const copy = { ...source };
      source.count = 2;
      const read = source.token;
    `);

    expect(
      ir.objectOperations.map(({ kind, propertyName, resolution }) => ({
        kind,
        propertyName,
        resolution,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "destructure",
          propertyName: "token",
          resolution: "complete",
        },
        { kind: "spread", propertyName: null, resolution: "complete" },
        { kind: "write", propertyName: "count", resolution: "complete" },
        { kind: "read", propertyName: "token", resolution: "complete" },
      ]),
    );
  });

  it("does not project positional argument flow after a spread", () => {
    const ir = analyzeJavaScriptSemantics(`
      function target(first, second, third) { return third; }
      target(one, ...rest, three);
    `);

    expect(ir.argumentFlows.map(({ argumentIndex }) => argumentIndex)).toEqual([
      0,
    ]);
  });

  it("applies independent hard bounds to every new semantic fact family", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        const captured = 1;
        function target(value, other) { return value + other + captured; }
        target(1, 2);
        target(3, 4);
        object[first];
        object[second];
      `,
      {
        maxCallSites: 1,
        maxCallArguments: 1,
        maxArgumentFlows: 0,
        maxCallReturnFlows: 0,
        maxClosureCaptures: 0,
        maxFrontiers: 1,
      },
    );

    expect(ir.callSites).toHaveLength(1);
    expect(ir.callSites[0]?.arguments).toEqual([
      expect.objectContaining({ index: 0, spread: false }),
    ]);
    expect(ir.argumentFlows).toEqual([]);
    expect(ir.callReturnFlows).toEqual([]);
    expect(ir.closureCaptures).toEqual([]);
    expect(ir.frontiers).toHaveLength(1);
    expect(ir.coverage).toMatchObject({
      status: "truncated",
      limitsReached: expect.arrayContaining([
        "maxCallSites",
        "maxCallArguments",
        "maxArgumentFlows",
        "maxCallReturnFlows",
        "maxClosureCaptures",
        "maxFrontiers",
      ]),
    });
  });

  it("recovers only direct return sites with literal and unknown object fields", () => {
    const ir = analyzeJavaScriptSemantics(`
      export default function parseMarkdown(value) {
        if (value.startsWith("# "))
          return { type: "heading", depth: 1, text: value.slice(2) };
        function nested() { return { type: "nested" }; }
        const arrow = () => ({ type: "arrow" });
        void nested; void arrow;
        return { type: "paragraph", text: value.replaceAll("x", "y") };
      }
    `);

    const parse = onlyCallable(ir, "parseMarkdown");
    expect(parse.returnCoverage).toEqual({
      status: "complete",
      retainedCount: 2,
      omittedCount: 0,
      limitsReached: [],
    });
    expect(parse.returnSites).toHaveLength(2);
    expect(parse.returnSites[0]?.value).toMatchObject({
      status: "object",
      unknownProperties: false,
      omittedProperties: 0,
      properties: expect.arrayContaining([
        { name: "depth", value: { status: "literal", value: 1 } },
        { name: "type", value: { status: "literal", value: "heading" } },
        {
          name: "text",
          value: {
            status: "unknown",
            reason: "Unsupported CallExpression value.",
          },
        },
      ]),
    });
    expect(onlyCallable(ir, "nested").returnSites).toHaveLength(1);
    expect(onlyCallable(ir, "arrow").returnSites).toHaveLength(1);
    expect(ir.moduleLinks).toContainEqual(
      expect.objectContaining({
        exportedName: "default",
        callableId: parse.callableId,
      }),
    );
  });
});

describe("JavaScript semantic analysis: dataflow 2", () => {
  it("retains partial property coverage, empty returns, and return limits", () => {
    const partial = analyzeJavaScriptSemantics(`
      const spread = () => ({ type: "spread", ...dynamic });
      const computed = () => ({ type: "computed", [key]: 1 });
      function noReturn() { throw new Error("stop"); }
      function emptyReturn() { return; }
    `);
    expect(onlyCallable(partial, "spread").returnSites[0]?.value).toMatchObject(
      {
        status: "object",
        unknownProperties: true,
        omittedProperties: null,
      },
    );
    expect(
      onlyCallable(partial, "computed").returnSites[0]?.value,
    ).toMatchObject({
      status: "object",
      unknownProperties: true,
      omittedProperties: 1,
    });
    expect(onlyCallable(partial, "noReturn").returnSites).toEqual([]);
    expect(onlyCallable(partial, "emptyReturn").returnSites[0]?.value).toEqual({
      status: "unknown",
      reason: "Return has no value.",
    });

    const limited = analyzeJavaScriptSemantics(
      "function many(value) { if (value) return 1; return 2; }",
      { maxReturnSites: 1 },
    );
    expect(onlyCallable(limited, "many")).toMatchObject({
      returnSites: [{ value: { status: "literal", value: 1 } }],
      returnCoverage: {
        status: "truncated",
        retainedCount: 1,
        omittedCount: 1,
        limitsReached: ["maxReturnSites"],
      },
    });
    expect(limited.coverage.limitsReached).toContain("maxReturnSites");
  });

  it("fails closed on assignment ambiguity, alias cycles, and lattice limits", () => {
    const ambiguous = analyzeJavaScriptSemantics(`
      let current = "first";
      current = "second";
      const left = right;
      const right = left;
    `);
    expect(topLevelBinding(ambiguous, "current").value).toMatchObject({
      status: "ambiguous",
    });
    expect(topLevelBinding(ambiguous, "left").value).toMatchObject({
      status: "cycle",
    });
    expect(topLevelBinding(ambiguous, "right").provenance).toMatchObject({
      status: "cycle",
    });

    const limited = analyzeJavaScriptSemantics(
      'const channel = enabled ? "one" : "two";',
      { maxUnionValues: 1 },
    );
    expect(topLevelBinding(limited, "channel").value).toEqual({
      status: "limit-reached",
      reason: "maxUnionValues reached.",
    });
    expect(limited.coverage).toMatchObject({
      status: "truncated",
      limitsReached: ["maxUnionValues"],
    });
    expect(limited.coverage.omittedCount).toBeGreaterThan(0);
  });

  it("does not invent exact module paths for dynamic property access", () => {
    const ir = analyzeJavaScriptSemantics(`
      const key = getKey();
      const dynamicMember = require("electron")[key];
      const { [key]: dynamicBinding } = require("electron");
    `);

    expect(topLevelBinding(ir, "dynamicMember").provenance).toMatchObject({
      status: "unknown",
      origins: [],
    });
    expect(topLevelBinding(ir, "dynamicBinding").provenance).toMatchObject({
      status: "unknown",
      origins: [],
    });
    expect(
      ir.moduleLinks.filter(({ localName }) =>
        ["dynamicMember", "dynamicBinding"].includes(localName ?? ""),
      ),
    ).toEqual([]);
  });

  it("bounds retained scopes and bindings without corrupting outer resolution", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        const retained = "yes";
        const omitted = "no";
        retained;
        function nested(value) { return retained + value; }
      `,
      { maxBindings: 1, maxCallables: 0, maxScopes: 1 },
    );

    expect(ir.bindings.map(({ name }) => name)).toEqual(["retained"]);
    expect(ir.callables).toEqual([]);
    expect(ir.coverage.status).toBe("truncated");
    expect(ir.coverage.limitsReached).toEqual(
      expect.arrayContaining(["maxBindings", "maxCallables", "maxScopes"]),
    );
    expect(ir.references.filter(({ name }) => name === "retained")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resolution: "resolved",
          bindingId: topLevelBinding(ir, "retained").bindingId,
        }),
        expect.objectContaining({ resolution: "unknown", bindingId: null }),
      ]),
    );
  });
});
