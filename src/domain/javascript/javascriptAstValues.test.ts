import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  javaScriptExpressionResultIsUsed,
  semanticMemberChain,
  semanticStaticPropertyKey,
  staticObjectProperty,
  staticObjectPropertyReader,
  staticObjectCopyPropertyReader,
  staticObjectPropertyNames,
} from "./javascriptAstValues.js";

it("keeps missing and mismatched result-parent edges conservative", () => {
  const call = t.callExpression(t.identifier("invoke"), []);
  const other = t.numericLiteral(0);
  const parents = new WeakMap<t.Node, t.Node>();
  expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(true);
  for (const parent of [
    t.expressionStatement(other),
    t.unaryExpression("void", other),
    t.sequenceExpression([other]),
    t.parenthesizedExpression(other),
    t.tsAsExpression(other, t.tsUnknownKeyword()),
    t.conditionalExpression(other, other, other),
    t.logicalExpression("&&", other, other),
    t.forStatement(other, null, other, t.emptyStatement()),
  ]) {
    parents.set(call, parent);
    if (t.isExpression(parent))
      parents.set(parent, t.expressionStatement(parent));
    expect(javaScriptExpressionResultIsUsed(call, parents), parent.type).toBe(
      true,
    );
  }
});

it("follows an explicit grouping wrapper through a final comma operand", () => {
  const call = t.callExpression(t.identifier("invoke"), []);
  const wrapper = t.parenthesizedExpression(call);
  const sequence = t.sequenceExpression([t.numericLiteral(0), wrapper]);
  const parents = new WeakMap<t.Node, t.Node>([
    [call, wrapper],
    [wrapper, sequence],
  ]);
  expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(true);
  parents.set(sequence, t.expressionStatement(sequence));
  expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(false);
  parents.set(sequence, t.callExpression(t.identifier("consume"), [sequence]));
  expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(true);
  parents.delete(sequence);
  expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(true);
});

it.each([128, 256, 512])(
  "indexes comma membership once for %i sibling calls per parent map",
  (count) => {
    const calls = Array.from({ length: count }, () =>
      t.callExpression(t.identifier("invoke"), []),
    );
    const sequence = t.sequenceExpression(calls);
    let memberReads = 0;
    sequence.expressions = new Proxy(sequence.expressions, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) memberReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const parentMap = () =>
      new WeakMap<t.Node, t.Node>([
        ...calls.map((call): [t.Node, t.Node] => [call, sequence]),
        [sequence, t.expressionStatement(sequence)],
      ]);
    const parents = parentMap();
    for (const call of calls)
      expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(false);
    expect(memberReads).toBeLessThanOrEqual(count * 2);
    const firstReads = memberReads;
    for (const call of calls)
      expect(javaScriptExpressionResultIsUsed(call, parents)).toBe(false);
    expect(memberReads - firstReads).toBeLessThanOrEqual(count);
    const repeatedReads = memberReads;
    const independentParents = parentMap();
    for (const call of calls)
      expect(javaScriptExpressionResultIsUsed(call, independentParents)).toBe(
        false,
      );
    // A different analysis owns its own membership, even for the same AST.
    expect(memberReads - repeatedReads).toBe(firstReads);
  },
);

it("keeps sequence membership isolated and rejects mismatches after indexing", () => {
  const first = t.callExpression(t.identifier("first"), []);
  const second = t.callExpression(t.identifier("second"), []);
  const firstSequence = t.sequenceExpression([first, t.numericLiteral(0)]);
  const secondSequence = t.sequenceExpression([second, t.numericLiteral(0)]);
  const parents = new WeakMap<t.Node, t.Node>([
    [first, firstSequence],
    [second, secondSequence],
  ]);
  expect(javaScriptExpressionResultIsUsed(first, parents)).toBe(false);
  expect(javaScriptExpressionResultIsUsed(second, parents)).toBe(false);
  parents.set(first, secondSequence);
  expect(javaScriptExpressionResultIsUsed(first, parents)).toBe(true);
  parents.delete(first);
  expect(javaScriptExpressionResultIsUsed(first, parents)).toBe(true);
});

it("keeps string spread indices separate from named descriptor fields", () => {
  for (const text of ["", "x", "😀", "x".repeat(1_000_000)]) {
    const original = t.objectProperty(
      t.identifier("value"),
      t.identifier("sender"),
    );
    const object = t.objectExpression([
      original,
      t.spreadElement(t.stringLiteral(text)),
    ]);
    const read = staticObjectPropertyReader(object);
    expect(read("value")).toEqual({
      status: "explicit",
      property: original,
      value: original.value,
    });
    expect(read("get")).toEqual({ status: "missing" });
    expect(read("set")).toEqual({ status: "missing" });
    expect(read("0").status).toBe(text.length > 0 ? "dynamic" : "missing");
    expect(read("1").status).toBe(text.length > 1 ? "dynamic" : "missing");
    for (const key of ["00", "-0", "1.0", "length"])
      expect(read(key)).toEqual({ status: "missing" });
    // Nonempty strings keep their indexed inventory partial without expanding
    // it into character-sized AST nodes or a potentially huge key-name array.
    expect(staticObjectPropertyNames(object)).toEqual({
      status: text.length > 0 ? "partial" : "complete",
      names: ["value"],
    });
  }
});

it("keeps numeric overwrite order and constant template string spread keys", () => {
  const property = t.objectProperty(
    t.stringLiteral("0"),
    t.identifier("original"),
  );
  const spread = t.spreadElement(
    t.templateLiteral([t.templateElement({ raw: "x", cooked: "x" }, true)], []),
  );
  expect(
    staticObjectProperty(t.objectExpression([property, spread]), "0").status,
  ).toBe("dynamic");
  expect(
    staticObjectProperty(t.objectExpression([spread, property]), "0"),
  ).toEqual({ status: "explicit", property, value: property.value });
});

it("keeps literal array indices, holes and unknown iterable suffixes separate from names", () => {
  const value = t.objectProperty(t.identifier("value"), t.identifier("sender"));
  for (const elements of [
    [],
    [null, null],
    [t.numericLiteral(1)],
    [null, t.numericLiteral(1)],
    [null, t.spreadElement(t.identifier("input"))],
  ]) {
    const object = t.objectExpression([
      value,
      t.spreadElement(t.arrayExpression(elements)),
    ]);
    const read = staticObjectPropertyReader(object);
    expect(read("value")).toEqual({
      status: "explicit",
      property: value,
      value: value.value,
    });
    expect(read("get")).toEqual({ status: "missing" });
    expect(read("set")).toEqual({ status: "missing" });
    expect(read("0").status).toBe(elements[0] == null ? "missing" : "dynamic");
    expect(read("1").status).toBe(elements[1] == null ? "missing" : "dynamic");
    expect(read("100").status).toBe(
      elements.some((entry) => t.isSpreadElement(entry))
        ? "dynamic"
        : "missing",
    );
    expect(read("length")).toEqual({ status: "missing" });
    expect(staticObjectPropertyNames(object)).toEqual({
      status: elements.some((entry) => entry != null) ? "partial" : "complete",
      names: ["value"],
    });
  }
});

it("preserves ordinary method data values without executing getter effects", () => {
  const method = (name: string, computed = false) =>
    t.objectMethod(
      "method",
      t.identifier(name),
      [],
      t.blockStatement([]),
      computed,
    );
  const getter = t.objectMethod(
    "get",
    t.identifier("helper"),
    [],
    t.blockStatement([]),
  );
  const setter = t.objectMethod(
    "set",
    t.identifier("helper"),
    [t.identifier("value")],
    t.blockStatement([]),
  );
  for (const [member, status] of [
    [method("helper"), "explicit"],
    [setter, "explicit"],
    [method("stdio"), "explicit"],
    [getter, "dynamic"],
    [method("key", true), "dynamic"],
  ] as const) {
    const object = t.objectExpression([
      t.objectProperty(t.identifier("stdio"), t.stringLiteral("inherit")),
      t.spreadElement(t.objectExpression([member])),
    ]);
    expect(staticObjectProperty(object, "stdio").status).toBe(status);
  }
});

it("limits unary-plus keys to transparent numeric literals", () => {
  const wrapped = t.tsAsExpression(t.numericLiteral(1), t.tsNumberKeyword());
  expect(semanticStaticPropertyKey(t.unaryExpression("+", wrapped), true)).toBe(
    "1",
  );
  for (const argument of [
    t.stringLiteral("1"),
    t.bigIntLiteral(1n),
    t.identifier("input"),
  ])
    expect(
      semanticStaticPropertyKey(t.unaryExpression("+", argument), true),
    ).toBeNull();
});

it("reads nested inline object spreads beyond the former evaluator depth cap", () => {
  let object = t.objectExpression([
    t.objectProperty(t.identifier("stdio"), t.stringLiteral("inherit")),
  ]);
  for (let depth = 0; depth < 1_024; depth++)
    object = t.objectExpression([t.spreadElement(object)]);
  expect(staticObjectProperty(object, "stdio").status).toBe("explicit");
  expect(
    staticObjectProperty(t.objectExpression([t.spreadElement(object)]), "stdio")
      .status,
  ).toBe("explicit");
});

it("collects complete own-key sets through bounded literal spreads", () => {
  const names = staticObjectPropertyNames(
    t.objectExpression([
      t.spreadElement(
        t.objectExpression([
          t.objectProperty(t.identifier("query"), t.objectExpression([])),
          t.objectProperty(t.identifier("shared"), t.numericLiteral(1)),
        ]),
      ),
      t.objectProperty(t.identifier("direct"), t.objectExpression([])),
      t.objectProperty(t.identifier("shared"), t.numericLiteral(2)),
    ]),
  );
  expect(names).toEqual({
    status: "complete",
    names: ["query", "shared", "direct"],
  });
});

it("keeps key enumeration unknown when object membership is unresolved", () => {
  const dynamicSpread = t.identifier("dynamicProperties");
  const computedKey = t.identifier("propertyName");
  const cases = [
    t.objectExpression([
      t.spreadElement(dynamicSpread),
      t.objectProperty(t.identifier("direct"), t.objectExpression([])),
    ]),
    t.objectExpression([
      t.objectProperty(computedKey, t.objectExpression([]), true),
      t.objectProperty(t.identifier("direct"), t.objectExpression([])),
    ]),
    t.objectExpression([
      t.spreadElement(
        t.objectExpression([
          t.objectMethod(
            "get",
            t.identifier("query"),
            [],
            t.blockStatement([]),
          ),
        ]),
      ),
    ]),
  ];
  for (const object of cases)
    expect(staticObjectPropertyNames(object).status).toBe("partial");
});

it("retains known keys alongside unresolved object membership", () => {
  expect(
    staticObjectPropertyNames(
      t.objectExpression([
        t.spreadElement(t.identifier("dynamicProperties")),
        t.objectProperty(t.identifier("direct"), t.objectExpression([])),
        t.objectProperty(
          t.identifier("propertyName"),
          t.objectExpression([]),
          true,
        ),
      ]),
    ),
  ).toEqual({ status: "partial", names: ["direct"] });
});

it("keeps complete key sets across deeply nested finite inline spreads", () => {
  let object = t.objectExpression([
    t.objectProperty(t.identifier("query"), t.objectExpression([])),
  ]);
  for (let depth = 0; depth < 1_024; depth++)
    object = t.objectExpression([t.spreadElement(object)]);
  expect(staticObjectPropertyNames(object).status).toBe("complete");
  expect(
    staticObjectPropertyNames(t.objectExpression([t.spreadElement(object)]))
      .status,
  ).toBe("complete");
});

it("enumerates a wide inline spread without a variadic call overflow", () => {
  const properties = Array.from({ length: 130_000 }, (_, index) =>
    t.objectProperty(t.identifier(`key${index}`), t.numericLiteral(index)),
  );
  const result = staticObjectPropertyNames(
    t.objectExpression([t.spreadElement(t.objectExpression(properties))]),
  );
  expect(result.status).toBe("complete");
  if (result.status === "complete") {
    expect(result.names).toHaveLength(properties.length);
    expect(result.names[0]).toBe("key0");
    expect(result.names.at(-1)).toBe("key129999");
  }
});

it("excludes prototype setters from own keys but preserves other __proto__ forms", () => {
  const setter = t.objectProperty(
    t.identifier("__proto__"),
    t.objectExpression([
      t.objectProperty(t.identifier("inherited"), t.numericLiteral(1)),
    ]),
  );
  expect(
    staticObjectPropertyNames(
      t.objectExpression([
        setter,
        t.objectProperty(t.identifier("own"), t.numericLiteral(2)),
      ]),
    ),
  ).toEqual({ status: "complete", names: ["own"] });

  const ownForms = [
    t.objectProperty(t.stringLiteral("__proto__"), t.numericLiteral(1), true),
    t.objectProperty(
      t.identifier("__proto__"),
      t.identifier("__proto__"),
      false,
      true,
    ),
    t.objectMethod(
      "method",
      t.identifier("__proto__"),
      [],
      t.blockStatement([]),
    ),
  ];
  for (const member of ownForms)
    expect(staticObjectPropertyNames(t.objectExpression([member]))).toEqual({
      status: "complete",
      names: ["__proto__"],
    });
});

it("keeps inherited lookup uncertain after a top-level prototype setter", () => {
  const setter = t.objectProperty(
    t.identifier("__proto__"),
    t.objectExpression([
      t.objectProperty(t.identifier("inherited"), t.numericLiteral(1)),
    ]),
  );
  expect(
    staticObjectProperty(t.objectExpression([setter]), "inherited").status,
  ).toBe("dynamic");
  expect(
    staticObjectProperty(
      t.objectExpression([
        setter,
        t.objectProperty(t.identifier("inherited"), t.numericLiteral(2)),
      ]),
      "inherited",
    ).status,
  ).toBe("explicit");
  expect(
    staticObjectProperty(
      t.objectExpression([
        t.objectProperty(t.identifier("inherited"), t.numericLiteral(2)),
        setter,
      ]),
      "inherited",
    ).status,
  ).toBe("explicit");
  const spreadSource = t.objectExpression([
    setter,
    t.objectProperty(t.identifier("visible"), t.numericLiteral(3)),
  ]);
  expect(
    staticObjectProperty(
      t.objectExpression([t.spreadElement(spreadSource)]),
      "inherited",
    ).status,
  ).toBe("missing");
});

it("omits prototype setters copied by literal object spread", () => {
  const source = t.objectExpression([
    t.objectProperty(
      t.identifier("__proto__"),
      t.objectExpression([
        t.objectProperty(t.identifier("hidden"), t.numericLiteral(1)),
      ]),
    ),
    t.objectProperty(t.identifier("visible"), t.numericLiteral(2)),
  ]);
  expect(
    staticObjectPropertyNames(t.objectExpression([t.spreadElement(source)])),
  ).toEqual({ status: "complete", names: ["visible"] });
});

it("shares static member paths and stops before unadmitted path expansion", () => {
  const root = t.identifier("registry");
  const selected = t.optionalMemberExpression(
    t.memberExpression(
      t.tsAsExpression(root, t.tsUnknownKeyword()),
      t.stringLiteral("query"),
      true,
    ),
    t.identifier("nested"),
    false,
    true,
  );
  expect(semanticMemberChain(selected)).toEqual({
    root,
    members: ["query", "nested"],
  });
  expect(
    semanticMemberChain(t.memberExpression(root, t.identifier("key"), true)),
  ).toBeUndefined();
  let admitted = 0;
  expect(semanticMemberChain(selected, () => ++admitted < 2)).toBeUndefined();
  expect(admitted).toBe(2);
});

it("retains exact ordinary method data nodes while keeping accessors unknown", () => {
  const method = t.objectMethod(
    "method",
    t.identifier("value"),
    [],
    t.blockStatement([]),
  );
  const getter = t.objectMethod(
    "get",
    t.identifier("value"),
    [],
    t.blockStatement([]),
  );
  expect(staticObjectProperty(t.objectExpression([method]), "value")).toEqual({
    status: "explicit",
    property: method,
    value: method,
  });
  expect(staticObjectProperty(t.objectExpression([getter]), "value")).toEqual({
    status: "dynamic",
  });
});

it("keeps primitive unary results propertyless and typeof results index-only", () => {
  const value = t.objectProperty(t.identifier("value"), t.identifier("sender"));
  const index = t.objectProperty(
    t.stringLiteral("0"),
    t.stringLiteral("prior"),
  );
  for (const operator of ["+", "-", "~", "!", "void", "delete"] as const) {
    const object = t.objectExpression([
      value,
      index,
      t.spreadElement(t.unaryExpression(operator, t.numericLiteral(1))),
    ]);
    expect(staticObjectProperty(object, "value")).toEqual({
      status: "explicit",
      property: value,
      value: value.value,
    });
    expect(staticObjectProperty(object, "0")).toEqual({
      status: "explicit",
      property: index,
      value: index.value,
    });
  }
  const object = t.objectExpression([
    value,
    index,
    t.spreadElement(t.unaryExpression("typeof", t.identifier("input"))),
  ]);
  expect(staticObjectProperty(object, "value")).toEqual({
    status: "explicit",
    property: value,
    value: value.value,
  });
  expect(staticObjectProperty(object, "0")).toEqual({ status: "dynamic" });
});

it("keeps enumerable-copy facts separate from inherited lookup", () => {
  const inherited = t.objectExpression([
    t.objectProperty(
      t.identifier("__proto__"),
      t.objectExpression([
        t.objectProperty(
          t.identifier("minVersion"),
          t.stringLiteral("TLSv1.2"),
        ),
      ]),
    ),
  ]);
  expect(staticObjectPropertyReader(inherited)("minVersion").status).toBe(
    "dynamic",
  );
  expect(staticObjectCopyPropertyReader(inherited)("minVersion").status).toBe(
    "missing",
  );
  const value = t.objectExpression([]);
  const copied = t.objectExpression([
    t.objectProperty(t.stringLiteral("__proto__"), value, true),
  ]);
  expect(staticObjectCopyPropertyReader(copied)("__proto__")).toMatchObject({
    status: "explicit",
    value,
  });
});
it("ignores null and propertyless copy sources without erasing indexed strings", () => {
  for (const source of [
    t.nullLiteral(),
    t.numericLiteral(1),
    t.arrowFunctionExpression([], t.numericLiteral(1)),
  ])
    expect(staticObjectCopyPropertyReader(source)("minVersion").status).toBe(
      "missing",
    );
  const read = staticObjectCopyPropertyReader(t.stringLiteral("abc"));
  expect(read("0").status).toBe("dynamic");
  expect(read("minVersion").status).toBe("missing");
});
