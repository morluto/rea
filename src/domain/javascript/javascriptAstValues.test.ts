import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  semanticMemberChain,
  semanticStaticPropertyKey,
  staticObjectOwnMethodReader,
  staticObjectProperty,
  staticObjectPropertyReader,
  staticObjectCopyPropertyReader,
  staticObjectPropertyNames,
} from "./javascriptAstValues.js";

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

it("leaves only the keys a conditional literal spread can copy unresolved", () => {
  const preload = t.objectProperty(
    t.identifier("preload"),
    t.stringLiteral("./preload.js"),
  );
  const frame = () =>
    t.objectExpression([
      t.objectProperty(t.identifier("frame"), t.booleanLiteral(false)),
    ]);
  const flag = t.identifier("flag");
  // A falsy comparison copies no keys; a string branch copies its indices.
  const comparison = t.binaryExpression("===", flag, t.stringLiteral("darwin"));
  for (const [argument, first, third] of [
    [t.logicalExpression("&&", comparison, frame()), "missing", "missing"],
    [
      t.conditionalExpression(flag, frame(), t.nullLiteral()),
      "missing",
      "missing",
    ],
    [
      t.conditionalExpression(flag, t.stringLiteral("ab"), frame()),
      "dynamic",
      "missing",
    ],
  ] as const) {
    const object = t.objectExpression([preload, t.spreadElement(argument)]);
    const read = staticObjectPropertyReader(object);
    for (const lookup of [
      read,
      (name: string) => staticObjectProperty(object, name),
    ]) {
      expect(lookup("preload")).toEqual({
        status: "explicit",
        property: preload,
        value: preload.value,
      });
      expect(lookup("frame")).toEqual({ status: "dynamic" });
      expect(lookup("sandbox")).toEqual({ status: "missing" });
      expect(lookup("0").status).toBe(first);
      expect(lookup("2").status).toBe(third);
    }
    expect(staticObjectPropertyNames(object)).toEqual({
      status: "partial",
      names: ["preload"],
    });
  }
  const override = t.spreadElement(
    t.logicalExpression(
      "&&",
      comparison,
      t.objectExpression([
        t.objectProperty(t.identifier("preload"), t.identifier("runtimePath")),
      ]),
    ),
  );
  expect(
    staticObjectProperty(t.objectExpression([preload, override]), "preload"),
  ).toEqual({
    status: "dynamic",
  });
  expect(
    staticObjectProperty(t.objectExpression([override, preload]), "preload"),
  ).toEqual({
    status: "explicit",
    property: preload,
    value: preload.value,
  });
  const method = t.objectMethod(
    "method",
    t.identifier("run"),
    [],
    t.blockStatement([]),
  );
  const branch = (name: string) =>
    t.spreadElement(
      t.logicalExpression(
        "&&",
        comparison,
        t.objectExpression([
          t.objectProperty(t.identifier(name), t.numericLiteral(1)),
        ]),
      ),
    );
  expect(
    staticObjectOwnMethodReader(t.objectExpression([method, branch("other")]))(
      "run",
    ),
  ).toBe(true);
  expect(
    staticObjectOwnMethodReader(t.objectExpression([method, branch("run")]))(
      "run",
    ),
  ).toBe(false);
});

it("keeps fallback and unresolved conditional spreads unknown", () => {
  const preload = t.objectProperty(
    t.identifier("preload"),
    t.stringLiteral("./preload.js"),
  );
  const flag = t.identifier("flag");
  const comparison = t.binaryExpression("===", flag, t.stringLiteral("darwin"));
  const frame = t.objectExpression([
    t.objectProperty(t.identifier("frame"), t.booleanLiteral(false)),
  ]);
  for (const argument of [
    t.logicalExpression("||", flag, frame),
    t.logicalExpression("??", flag, frame),
    t.conditionalExpression(flag, t.identifier("input"), frame),
    // A falsy `&&` operand is copied itself, and document.all, the only
    // falsy object, can carry an expando with any key.
    t.logicalExpression("&&", flag, frame),
    t.logicalExpression(
      "&&",
      comparison,
      t.objectExpression([
        t.objectMethod("get", t.identifier("frame"), [], t.blockStatement([])),
      ]),
    ),
    t.logicalExpression(
      "&&",
      comparison,
      t.objectExpression([
        t.objectProperty(t.identifier("key"), t.booleanLiteral(true), true),
      ]),
    ),
    t.logicalExpression(
      "&&",
      comparison,
      t.objectExpression([t.spreadElement(t.identifier("input"))]),
    ),
  ]) {
    const object = t.objectExpression([preload, t.spreadElement(argument)]);
    expect(staticObjectProperty(object, "preload")).toEqual({
      status: "dynamic",
    });
    expect(staticObjectPropertyReader(object)("sandbox")).toEqual({
      status: "dynamic",
    });
    expect(staticObjectPropertyNames(object)).toEqual({
      status: "partial",
      names: ["preload"],
    });
  }
});

it("reads nested conditional spreads beyond the former evaluator depth cap", () => {
  const preload = t.objectProperty(
    t.identifier("preload"),
    t.stringLiteral("./preload.js"),
  );
  const negation = () => t.unaryExpression("!", t.identifier("flag"));
  const frame = () =>
    t.objectExpression([
      t.objectProperty(t.identifier("frame"), t.booleanLiteral(false)),
    ]);
  const wrapped = (
    wrap: (inner: t.Expression) => t.Expression,
    levels: number,
  ): t.Expression => {
    let argument: t.Expression = frame();
    for (let level = 0; level < levels; level++) argument = wrap(argument);
    return argument;
  };
  // A left-deep chain nests one level per operand; a recursive reader
  // overflows the stack at this length.
  let chain: t.Expression = negation();
  for (let operand = 0; operand < 20_000; operand++)
    chain = t.logicalExpression("&&", chain, negation());
  for (const argument of [
    wrapped((inner) => t.logicalExpression("&&", negation(), inner), 1_024),
    wrapped(
      (inner) => t.conditionalExpression(negation(), inner, t.nullLiteral()),
      1_024,
    ),
    t.logicalExpression("&&", chain, frame()),
  ]) {
    const object = t.objectExpression([preload, t.spreadElement(argument)]);
    expect(staticObjectProperty(object, "preload").status).toBe("explicit");
    expect(staticObjectProperty(object, "frame")).toEqual({
      status: "dynamic",
    });
    expect(staticObjectPropertyNames(object)).toEqual({
      status: "partial",
      names: ["preload"],
    });
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

it("reads an inline object nested in 1,024 spreads", () => {
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

it("bounds conditional copy sources by the keys their branches may copy", () => {
  const flag = t.identifier("flag");
  const comparison = t.binaryExpression("===", flag, t.stringLiteral("darwin"));
  const version = () =>
    t.objectExpression([
      t.objectProperty(t.identifier("minVersion"), t.stringLiteral("TLSv1.2")),
    ]);
  for (const source of [
    t.conditionalExpression(flag, version(), t.nullLiteral()),
    t.logicalExpression("&&", comparison, version()),
  ]) {
    const read = staticObjectCopyPropertyReader(source);
    // A possibly copied key is unresolved; every other key is not copied.
    expect(read("minVersion")).toEqual({ status: "dynamic" });
    expect(read("maxVersion")).toEqual({ status: "missing" });
  }
  // An unresolved `&&` operand is copied itself, so no key is bounded.
  const unresolved = staticObjectCopyPropertyReader(
    t.logicalExpression("&&", flag, version()),
  );
  expect(unresolved("minVersion")).toEqual({ status: "dynamic" });
  expect(unresolved("maxVersion")).toEqual({ status: "dynamic" });
});
