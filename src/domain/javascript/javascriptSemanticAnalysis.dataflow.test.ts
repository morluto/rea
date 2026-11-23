import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  onlyCallable,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: dataflow 1", () => {
  it("attributes object operations to their bindings and leaves dynamic keys unresolved", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { token: "TOKEN", kind: "config", 1: "one" };
      const key = getKey();
      const { [key]: dynamic } = source;
      const { token, ["kind"]: literal, [1]: numeric } = source;
      const copy = { ...source };
      source.count = 2;
      const read = source.token;
    `);
    const bindingNames = new Map(
      ir.bindings.map(({ bindingId, name }) => [bindingId, name]),
    );
    const name = (id: string | null) =>
      id === null ? null : bindingNames.get(id);
    expect(
      ir.objectOperations.map(
        ({
          kind,
          objectBindingId,
          targetBindingId,
          propertyPath,
          resolution,
        }) => [
          kind,
          name(objectBindingId),
          name(targetBindingId),
          propertyPath,
          resolution,
        ],
      ),
    ).toEqual([
      ["destructure", "source", "token", ["token"], "complete"],
      ["destructure", "source", "literal", ["kind"], "complete"],
      ["destructure", "source", "numeric", ["1"], "complete"],
      ["spread", "source", null, [], "complete"],
      ["write", "source", null, ["count"], "complete"],
      ["read", "source", null, ["token"], "complete"],
    ]);
    expect(topLevelBinding(ir, "dynamic").value.status).toBe("unknown");
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
    expect(parse.returnSites.map(({ value }) => value)).toMatchObject([
      {
        status: "object",
        unknownProperties: false,
        omittedProperties: 0,
        properties: [
          {
            name: "depth",
            presence: "present",
            value: { status: "literal", value: 1 },
          },
          { name: "text", presence: "present", value: { status: "unknown" } },
          {
            name: "type",
            presence: "present",
            value: { status: "literal", value: "heading" },
          },
        ],
      },
      {
        status: "object",
        unknownProperties: false,
        omittedProperties: 0,
        properties: [
          { name: "text", presence: "present", value: { status: "unknown" } },
          {
            name: "type",
            presence: "present",
            value: { status: "literal", value: "paragraph" },
          },
        ],
      },
    ]);
    for (const name of ["nested", "arrow"])
      expect(
        onlyCallable(ir, name).returnSites.map(({ value }) => value),
      ).toMatchObject([
        {
          status: "object",
          properties: [
            {
              name: "type",
              presence: "present",
              value: { status: "literal", value: name },
            },
          ],
        },
      ]);
    expect(ir.moduleLinks).toContainEqual(
      expect.objectContaining({
        exportedName: "default",
        callableId: parse.callableId,
      }),
    );
  });
});

it("attributes repeated calls and unresolved member reads to their own sites", () => {
  const ir = analyzeJavaScriptSemantics(
    [
      "function target(value) { return value; }",
      "target(1);",
      "target(2);",
      "object[first];",
      "object[second];",
    ].join("\n"),
  );
  const target = onlyCallable(ir, "target");
  expect(ir.callSites).toMatchObject([
    {
      calleeCallableIds: [target.callableId],
      location: { start: { line: 2, column: 0 } },
    },
    {
      calleeCallableIds: [target.callableId],
      location: { start: { line: 3, column: 0 } },
    },
  ]);
  expect(ir.argumentFlows).toMatchObject(
    ir.callSites.map(({ callSiteId }) => ({
      callSiteId,
      argumentIndex: 0,
    })),
  );
  expect(ir.callReturnFlows).toMatchObject(
    ir.callSites.map(({ callSiteId }) => ({
      callSiteId,
      callableId: target.callableId,
      returnSiteId: target.returnSites[0]?.returnSiteId,
    })),
  );
  expect(ir.frontiers).toMatchObject([
    {
      kind: "dynamic-property",
      location: {
        start: { line: 4, column: 7 },
        end: { line: 4, column: 12 },
      },
    },
    {
      kind: "dynamic-property",
      location: {
        start: { line: 5, column: 7 },
        end: { line: 5, column: 13 },
      },
    },
  ]);
});

describe("JavaScript semantic call result flows", () => {
  it("links only directly assigned scalar call results", () => {
    const ir = analyzeJavaScriptSemantics(`
      function run() {
        const direct = produce();
        const { field } = unpack();
        const nested = outer(inner());
        return direct;
      }
    `);
    const bindingNames = new Map(
      ir.bindings.map(({ bindingId, name }) => [bindingId, name]),
    );

    const calls = new Map(
      ir.callSites.map(({ callSiteId, location }) => [
        callSiteId,
        location.start,
      ]),
    );
    expect(
      ir.callResultFlows.map(({ bindingId, callSiteId }) => ({
        binding: bindingNames.get(bindingId),
        start: calls.get(callSiteId),
      })),
    ).toEqual([
      { binding: "direct", start: { line: 3, column: 23 } },
      { binding: "nested", start: { line: 5, column: 23 } },
    ]);
  });
});

describe("JavaScript semantic analysis: read-modify-write", () => {
  it("distinguishes member reads, writes, and read-modify-write operations", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = {};
      const value = source.read;
      source.plain = 2;
      source.arithmetic += 1;
      source.logical ??= 1;
      source.increment++;
      source.nonNull!++;
      (source.cast as number) += 1;
      (source.parenthesized)++;
      (source.castPlain as number) = 2;
      delete source.nonNullDelete!;
    `);
    expect(
      ir.objectOperations.map(({ kind, propertyPath }) => [kind, propertyPath]),
    ).toEqual([
      ["read", ["read"]],
      ["write", ["plain"]],
      ["read", ["arithmetic"]],
      ["write", ["arithmetic"]],
      ["read", ["logical"]],
      ["write", ["logical"]],
      ["read", ["increment"]],
      ["write", ["increment"]],
      ["read", ["nonNull"]],
      ["write", ["nonNull"]],
      ["read", ["cast"]],
      ["write", ["cast"]],
      ["read", ["parenthesized"]],
      ["write", ["parenthesized"]],
      ["write", ["castPlain"]],
      ["write", ["nonNullDelete"]],
    ]);
  });

  it.each([
    ["destructuring assignment", "[source.count] = [2];"],
    ["destructuring assignment with default", "[source.count = 2] = [];"],
    [
      "nested destructuring assignment",
      "({ value: { count: source.count } } = {});",
    ],
    ["rest destructuring assignment", "[...source.items] = [];"],
    ["for-of head", "for (source.count of [4]) {}"],
    ["for-in head", "for (source.count in { key: true }) {}"],
    ["delete", "delete source.count;"],
  ])("records a member target in %s as a write", (_name, statement) => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { count: 1, items: [] };
      ${statement}
    `);
    expect(ir.objectOperations.map(({ kind }) => kind)).toEqual(["write"]);
  });

  it("keeps a member in a destructuring default value a read", () => {
    const ir = analyzeJavaScriptSemantics(`
      const source = { count: 1 };
      let value;
      [value = source.count] = [];
    `);
    expect(ir.objectOperations.map(({ kind }) => kind)).toEqual([
      "destructure",
      "read",
    ]);
  });

  it("does not model a compound binding write as a competing replacement", () => {
    const ir = analyzeJavaScriptSemantics(`
      let count = 1;
      count += 2;
    `);

    expect(topLevelBinding(ir, "count").value).toMatchObject({
      status: "unknown",
    });
  });
});

describe("JavaScript semantic analysis: wrapped binding targets", () => {
  it("records a wrapped identifier update as a read before a write", () => {
    const ir = analyzeJavaScriptSemantics(`
      let count = 1;
      count! += 1;
      (count as number)++;
      const copy = count!;
    `);
    expect(
      ir.references
        .filter(({ name }) => name === "count")
        .map(({ role }) => role),
    ).toEqual(["read", "write", "read", "write", "read"]);
    expect(topLevelBinding(ir, "count").value).toMatchObject({
      status: "unknown",
    });
  });

  it("records a wrapped identifier assignment as a write of its value", () => {
    const ir = analyzeJavaScriptSemantics(`
      let count = 1;
      count! = 2;
    `);
    expect(
      ir.references
        .filter(({ name }) => name === "count")
        .map(({ role }) => role),
    ).toEqual(["write"]);
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

  it("preserves initializer uncertainty, assignment ambiguity and alias cycles", () => {
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
      status: "unknown",
      reason: "Binding right has no proven initializer at this read.",
    });
    expect(topLevelBinding(ambiguous, "right").provenance).toMatchObject({
      status: "cycle",
    });
  });
});

describe("JavaScript semantic analysis: mapped arguments writes", () => {
  it("invalidates mapped parameters after direct, aliased and destructured arguments writes", () => {
    const parsed = parseJavaScriptSource(
      `
      function direct(value) { value = 1; arguments[0] = 2; return value; }
      function alias(value) { value = 1; const args = arguments; args[0] = 2; return value; }
      function array(value) { value = 1; [arguments[0]] = [2]; return value; }
      function object(value) { value = 1; ({nested: arguments[0]} = {nested: 2}); return value; }
      function strict(value) { "use strict"; value = 1; arguments[0] = 2; return value; }
      function defaulted(value = 0) { value = 1; arguments[0] = 2; return value; }
      function unrelated(value) { value = 1; const other = {}; other[0] = 2; return value; }
    `,
      "mapped-arguments.cjs",
    );
    if (parsed === null) throw new Error("Expected CommonJS fixture to parse");
    const ir = analyzeParsedJavaScriptSemantics(parsed);
    for (const name of ["direct", "alias", "array", "object"])
      expect(onlyCallable(ir, name).returnSites[0]?.value, name).toMatchObject({
        status: "ambiguous",
      });
    for (const name of ["strict", "defaulted", "unrelated"])
      expect(onlyCallable(ir, name).returnSites[0]?.value, name).toEqual({
        status: "literal",
        value: 1,
      });
  });

  it("retains uncertainty when source mode cannot establish sloppy semantics", () => {
    const ir = analyzeJavaScriptSemantics(
      "function read(value) { value = 1; arguments[0] = 2; return value; }",
    );
    expect(onlyCallable(ir, "read").returnSites[0]?.value).toMatchObject({
      status: "ambiguous",
    });
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
    ['1 + 2 + "3"', "33"],
    ['1 + (2 + "3")', "123"],
    ['(1 + 2) + ("3" + 4)', "334"],
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

describe("nonfinite static values", () => {
  it.each(['+"not-a-number"', '-"not-a-number"', "1e308 + 1e308", "1e309"])(
    "keeps %s unknown instead of publishing a non-JSON number",
    (expression) => {
      const ir = analyzeJavaScriptSemantics(`const answer = ${expression};`);
      expect(topLevelBinding(ir, "answer").value.status).toBe("unknown");
    },
  );
  it("does not collapse an uncertain nonfinite branch to its finite alternative", () => {
    const ir = analyzeJavaScriptSemantics(
      'const answer = condition ? 1 : +"invalid";',
    );
    expect(topLevelBinding(ir, "answer").value.status).toBe("ambiguous");
  });
});

describe("binding write invalidation", () => {
  it("preserves a binding across empty string loops and invalidates it across nonempty loops", () => {
    const continuedEmpty = "`\\\n`";
    const ir = analyzeJavaScriptSemantics(`
      let enumerated = "before";
      for (enumerated in "") {}
      const observed = enumerated;
      export function emptyForIn() { return observed; }
      export function emptyForOf() {
        let selected = "before";
        for ([selected] of ${continuedEmpty}) {}
        return selected;
      }
      export function nonemptyForIn() {
        let selected = "before";
        for ([selected] in "abc") {}
        return selected;
      }
      export function nonemptyForOf() {
        let selected = "before";
        for (selected of \`\\u0061\`) {}
        return selected;
      }
    `);
    for (const name of ["emptyForIn", "emptyForOf"])
      expect(onlyCallable(ir, name).returnSites[0]?.value).toEqual({
        status: "literal",
        value: "before",
      });
    for (const name of ["nonemptyForIn", "nonemptyForOf"])
      expect(onlyCallable(ir, name).returnSites[0]?.value).toMatchObject({
        status: "ambiguous",
      });
  });

  it("keeps empty-template loops uncertain when a prototype was changed", () => {
    const ir = analyzeJavaScriptSemantics(`
      String.prototype.extra = "possible inherited key";
      export function enumerate() {
        let selected = "before";
        for (selected in \`\`) {}
        return selected;
      }
      export function iterate() {
        let selected = "before";
        for (selected of \`\`) {}
        return selected;
      }
    `);
    for (const name of ["enumerate", "iterate"])
      expect(onlyCallable(ir, name).returnSites[0]?.value).toMatchObject({
        status: "ambiguous",
      });
  });

  it.each([
    ["let value = 1; value++; const observed = value;", "unknown"],
    [
      'let value = "old"; [value] = ["new"]; const observed = value;',
      "ambiguous",
    ],
    [
      'let value = "old"; ({key: value} = {key: "new"}); const observed = value;',
      "ambiguous",
    ],
    [
      'let value = "old"; for (value of ["new"]) {} const observed = value;',
      "ambiguous",
    ],
    [
      'let value = "old"; for (value in {new: true}) {} const observed = value;',
      "ambiguous",
    ],
  ] as const)(
    "does not retain an exact initializer across %s",
    (source, status) => {
      const ir = analyzeJavaScriptSemantics(source);
      expect(topLevelBinding(ir, "observed").value.status).toBe(status);
      expect(
        topLevelBinding(ir, "value").definitions.some(
          ({ kind }) => kind === "assignment",
        ),
      ).toBe(true);
    },
  );

  it("does not treat destructuring keys or member owners as assigned bindings", () => {
    const ir = analyzeJavaScriptSemantics(`
      const key = "stable";
      const owner = "stable";
      let target = "old";
      ({key: target} = {key: "new"});
      ({owner: object.slot} = {owner: "new"});
      const preservedKey = key;
      const preservedOwner = owner;
    `);
    for (const name of ["preservedKey", "preservedOwner"])
      expect(topLevelBinding(ir, name).value).toEqual({
        status: "literal",
        value: "stable",
      });
  });
});

describe("JavaScript semantic analysis: unknown default inputs", () => {
  it.each([
    'function launch(mode = "safe") { return mode; }',
    'function launch({ mode } = { mode: "safe" }) { return mode; }',
    'function launch([mode] = ["safe"]) { return mode; }',
  ])("does not assume an optional argument is omitted: %s", (source) => {
    const ir = analyzeJavaScriptSemantics(source);
    expect(onlyCallable(ir, "launch").returnSites[0]?.value.status).toBe(
      "unknown",
    );
  });

  it("preserves known declaration inputs and unknown catch bindings", () => {
    const ir = analyzeJavaScriptSemantics(`
      const { mode: retained = "fallback" } = { mode: "actual" };
      function caught() {
        try { risky(); } catch ({ message = "fallback" }) { return message; }
      }
    `);
    expect(topLevelBinding(ir, "retained").value).toMatchObject({
      status: "literal",
      value: "actual",
    });
    expect(onlyCallable(ir, "caught").returnSites[0]?.value.status).toBe(
      "unknown",
    );
  });
});
