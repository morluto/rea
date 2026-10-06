import { describe, expect, it } from "vitest";

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

  it("does not invent property names for dynamic destructuring keys", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { token: "TOKEN" };
      const key = getKey();
      const { [key]: dynamic } = source;
      const { ["token"]: literal } = source;
      const { token: renamed } = source;
      const { token } = source;
      const { [1]: numeric } = source;
    `);
    const destructures = ir.objectOperations.filter(
      ({ kind }) => kind === "destructure",
    );

    expect(destructures.map(({ propertyName }) => propertyName)).toEqual([
      "token",
      "token",
      "token",
      "1",
    ]);
    expect(
      destructures.every(({ resolution }) => resolution === "complete"),
    ).toBe(true);
    expect(topLevelBinding(ir, "dynamic").value.status).toBe("unknown");
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

  it("retains all statically recovered call, flow, capture, and frontier facts", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        const captured = 1;
        function target(value, other) { return value + other + captured; }
        target(1, 2);
        target(3, 4);
        object[first];
        object[second];
      `,
    );

    expect(ir.callSites).toHaveLength(2);
    expect(ir.callSites.map(({ arguments: args }) => args)).toEqual([
      [
        expect.objectContaining({ index: 0, spread: false }),
        expect.objectContaining({ index: 1, spread: false }),
      ],
      [
        expect.objectContaining({ index: 0, spread: false }),
        expect.objectContaining({ index: 1, spread: false }),
      ],
    ]);
    expect(ir.argumentFlows).toHaveLength(4);
    expect(ir.callReturnFlows).toHaveLength(2);
    expect(ir.closureCaptures).toHaveLength(1);
    expect(ir.frontiers).toHaveLength(2);
    expect(ir.coverage.status).toBe("complete");
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

describe("JavaScript semantic analysis: read-modify-write", () => {
  it.each(["+= 1", "++", "--", "||= 1", "&&= 1", "??= 1"])(
    "retains the property read in a read-modify-write operation: %s",
    (operator) => {
      const ir = analyzeJavaScriptSemantics(`
        const source = { count: 1 };
        source.count ${operator};
      `);
      expect(ir.objectOperations.map(({ kind }) => kind)).toEqual([
        "read",
        "write",
      ]);
    },
  );

  it("keeps plain member assignment write-only and member access read-only", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { count: 1 };
      source.count = 2;
      const value = source.count;
    `);
    expect(ir.objectOperations.map(({ kind }) => kind)).toEqual([
      "write",
      "read",
    ]);
  });
});

describe("JavaScript semantic analysis: dataflow 2", () => {
  it("retains partial property coverage and empty returns", () => {
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
  });

  it("fails closed on assignment ambiguity and alias cycles", () => {
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

  it("retains all scopes, bindings, and references without truncation", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        const retained = "yes";
        const omitted = "no";
        retained;
        function nested(value) { return retained + value; }
      `,
    );

    expect(ir.bindings.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["retained", "omitted", "value"]),
    );
    expect(ir.callables.map(({ name }) => name)).toContain("nested");
    expect(ir.coverage.status).toBe("complete");
    expect(ir.references.filter(({ name }) => name === "retained")).toEqual([
      expect.objectContaining({
        resolution: "resolved",
        bindingId: topLevelBinding(ir, "retained").bindingId,
      }),
      expect.objectContaining({
        resolution: "resolved",
        bindingId: topLevelBinding(ir, "retained").bindingId,
      }),
    ]);
  });
});

describe("primitive addition values", () => {
  it.each([
    ["true + 1", 2],
    ["null + 2", 2],
    ["false + true", 1],
    ['"x" + false', "xfalse"],
    ['null + "x"', "nullx"],
    ["3 + 4", 7],
  ])("recovers %s using primitive coercion", (expression, expected) => {
    const ir = analyzeJavaScriptSemantics(`const answer = ${expression};`);
    expect(topLevelBinding(ir, "answer").value).toEqual({
      status: "literal",
      value: expected,
    });
  });
});

describe("array positional value recovery", () => {
  it("keeps holes at their actual destructuring indices", () => {
    const ir = analyzeJavaScriptSemantics(`
      const list = ["zero", , "two"];
      const [first, second, third] = list;
    `);
    expect(topLevelBinding(ir, "first").value).toEqual({
      status: "literal",
      value: "zero",
    });
    expect(topLevelBinding(ir, "second").value.status).toBe("unknown");
    expect(topLevelBinding(ir, "third").value).toEqual({
      status: "literal",
      value: "two",
    });
  });

  it("projects canonical array indices without treating arbitrary strings as indices", () => {
    const ir = analyzeJavaScriptSemantics(`
      const list = ["zero", "one"];
      const numeric = list[1];
      const quoted = list["1"];
      const leadingZero = list["01"];
      const negative = list[-1];
    `);
    for (const name of ["numeric", "quoted"])
      expect(topLevelBinding(ir, name).value).toEqual({
        status: "literal",
        value: "one",
      });
    for (const name of ["leadingZero", "negative"])
      expect(topLevelBinding(ir, name).value.status).toBe("unknown");
  });

  it("does not shift trailing values across an unknown spread", () => {
    const ir = analyzeJavaScriptSemantics(`
      const values = ["first", ...unknownValues, "last"];
      const [first, second] = values;
    `);
    expect(topLevelBinding(ir, "first").value).toEqual({
      status: "literal",
      value: "first",
    });
    expect(topLevelBinding(ir, "second").value.status).toBe("unknown");
  });
});

describe("object value overwrite boundaries", () => {
  it("uses the last named property and keeps later exact overwrites", () => {
    const ir = analyzeJavaScriptSemantics(`
      const duplicate = { key: "old", key: "new" };
      const selected = duplicate.key;
      const later = { key: "old", ...unknownObject, key: "final" };
      const final = later.key;
    `);
    expect(topLevelBinding(ir, "selected").value).toEqual({
      status: "literal",
      value: "new",
    });
    expect(topLevelBinding(ir, "final").value).toEqual({
      status: "literal",
      value: "final",
    });
  });
  it("does not retain an exact earlier value after an unknown overwrite", () => {
    const ir = analyzeJavaScriptSemantics(`
      const spread = { key: "old", ...unknownObject };
      const dynamic = { key: "old", [unknownKey]: "new" };
      const method = { key: "old", key() { return "new"; } };
      const spreadValue = spread.key;
      const dynamicValue = dynamic.key;
      const methodValue = method.key;
    `);
    for (const name of ["spreadValue", "dynamicValue", "methodValue"])
      expect(topLevelBinding(ir, name).value.status).toBe("unknown");
  });
  it("admits literal computed keys while excluding prototype setters", () => {
    const ir = analyzeJavaScriptSemantics(`
      const object = { ["key"]: "value", __proto__: { prototype: true } };
      const selected = object.key;
      const prototype = object.__proto__;
    `);
    expect(topLevelBinding(ir, "selected").value).toEqual({
      status: "literal",
      value: "value",
    });
    expect(topLevelBinding(ir, "prototype").value.status).toBe("unknown");
  });
});

it("retains shorthand __proto__ as an own data property", () => {
  const ir = analyzeJavaScriptSemantics(`
    const __proto__ = "own";
    const object = { __proto__ };
    const selected = object.__proto__;
  `);
  expect(topLevelBinding(ir, "selected").value).toEqual({
    status: "literal",
    value: "own",
  });
});
