import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { readExactJavaScriptLiteral } from "./javascriptAstValues.js";
import { semanticPrimitiveSet } from "./javascriptSemanticPrimitives.js";
import { SEMANTIC_PRIMITIVE_SAMPLE_SCOPE_LIMIT } from "./javascriptSemanticResourceLimits.js";

const conditionalCandidates = [
  '"one"',
  '(choice ? "one" : "two")',
  '(choice ? "one" : other ? "two" : "three")',
];
const incompatibleValue = {
  status: "ambiguous",
  reason: "Branches have incompatible values.",
};

const valueOf = (expression: string) =>
  topLevelBinding(
    analyzeJavaScriptSemantics(`const answer = ${expression};`),
    "answer",
  ).value;

describe("exact JavaScript literal reader", () => {
  it("reads cooked atoms and rejects raw-only or interpolated templates", () => {
    const cookedElement = t.templateElement(
      { raw: "raw", cooked: "raw" },
      true,
    );
    cookedElement.value.cooked = "cooked";
    const rawOnlyElement = t.templateElement(
      { raw: "raw", cooked: "raw" },
      true,
    );
    rawOnlyElement.value.cooked = null;
    expect(readExactJavaScriptLiteral(t.stringLiteral(""))).toEqual({
      found: true,
      value: "",
    });
    expect(
      readExactJavaScriptLiteral(t.templateLiteral([cookedElement], [])),
    ).toEqual({ found: true, value: "cooked" });
    expect(
      readExactJavaScriptLiteral(t.templateLiteral([rawOnlyElement], [])),
    ).toEqual({ found: false });
    expect(
      readExactJavaScriptLiteral(
        t.templateLiteral(
          [
            t.templateElement({ raw: "", cooked: "" }, false),
            t.templateElement({ raw: "", cooked: "" }, true),
          ],
          [t.identifier("value")],
        ),
      ),
    ).toEqual({ found: false });
  });
});
const valuesOf = (expressions: readonly string[]) => {
  const ir = analyzeJavaScriptSemantics(
    expressions
      .map(
        (expression, index) =>
          `const candidate${String(index)} = ${expression};`,
      )
      .join("\n"),
  );
  return expressions.map(
    (_, index) => topLevelBinding(ir, `candidate${String(index)}`).value,
  );
};

describe("conditional primitive unions", () => {
  const cases = conditionalCandidates.flatMap((known) =>
    [
      "missing",
      "unsupported()",
      '({ key: "value" })',
      '["value"]',
      '+"invalid"',
      "1e309",
      "1e308 + 1e308",
    ].flatMap((other) => [
      `condition ? ${known} : ${other}`,
      `condition ? ${other} : ${known}`,
    ]),
  );

  it("preserves incompatible alternatives across conditional expressions", () => {
    expect(valuesOf(cases)).toEqual(cases.map(() => incompatibleValue));
  });

  const exactCases = [
    [
      'condition ? (choice ? "two" : "one") : "three"',
      { status: "union", values: ["one", "three", "two"] },
    ],
    [
      'condition ? "three" : (choice ? "two" : "one")',
      { status: "union", values: ["one", "three", "two"] },
    ],
    [
      'condition ? (choice ? "two" : "one") : (other ? "one" : "three")',
      { status: "union", values: ["one", "three", "two"] },
    ],
    [
      'condition ? (choice ? "two" : "one") : (other ? "one" : "two")',
      { status: "union", values: ["one", "two"] },
    ],
    [
      'condition ? (choice ? "one" : "one") : "one"',
      { status: "literal", value: "one" },
    ],
    [
      'condition ? (choice ? "one" : "two") : null',
      { status: "union", values: [null, "one", "two"] },
    ],
    [
      'condition ? null : (choice ? "one" : "two")',
      { status: "union", values: [null, "one", "two"] },
    ],
    ["condition ? null : null", { status: "literal", value: null }],
  ] as const;

  it("retains exact primitive candidates across conditional expressions", () => {
    expect(valuesOf(exactCases.map(([expression]) => expression))).toEqual(
      exactCases.map(([, expected]) => expected),
    );
  });

  it("propagates an incompatible nested branch through an outer union", () => {
    expect(
      valueOf(
        'condition ? (choice ? "one" : "two") : (other ? "three" : missing)',
      ),
    ).toEqual(incompatibleValue);
  });
});

describe("logical primitive unions", () => {
  // Each left-hand set can select the unresolved right-hand operand at runtime.
  const operators = [
    {
      operator: "||",
      alternatives: [
        '""',
        '(choice ? "" : "one")',
        '(choice ? "" : other ? "one" : "two")',
      ],
    },
    {
      operator: "&&",
      alternatives: [
        '"one"',
        '(choice ? 0 : "one")',
        '(choice ? 0 : other ? "one" : "two")',
      ],
    },
    {
      operator: "??",
      alternatives: [
        "null",
        '(choice ? null : "one")',
        '(choice ? null : other ? "one" : "two")',
      ],
    },
  ];
  const cases = operators.flatMap(({ operator, alternatives }) =>
    alternatives.flatMap((known) =>
      ["missing", "unsupported()"].flatMap((other) => [
        `${known} ${operator} ${other}`,
        `${other} ${operator} ${known}`,
      ]),
    ),
  );

  it("preserves unresolved alternatives across logical expressions", () => {
    expect(valuesOf(cases)).toEqual(cases.map(() => incompatibleValue));
  });

  const exactCases = [
    [
      '(choice ? "" : "one") || "two"',
      { status: "union", values: ["", "one", "two"] },
    ],
    [
      '(choice ? 0 : "one") && "two"',
      { status: "union", values: [0, "one", "two"] },
    ],
    [
      '(choice ? null : "one") ?? "two"',
      { status: "union", values: [null, "one", "two"] },
    ],
    ['"one" || "one"', { status: "literal", value: "one" }],
    ["null ?? null", { status: "literal", value: null }],
  ] as const;

  it("retains conservative primitive unions across logical expressions", () => {
    expect(valuesOf(exactCases.map(([expression]) => expression))).toEqual(
      exactCases.map(([, expected]) => expected),
    );
  });

  const unevaluatedCases = [
    'true ? "one" : missing',
    '"one" || missing',
    "false && missing",
    '"one" ?? missing',
  ];

  it("selects an established branch without evaluating an unreachable operand", () => {
    expect(valuesOf(unevaluatedCases)).toEqual([
      { status: "literal", value: "one" },
      { status: "literal", value: "one" },
      { status: "literal", value: false },
      { status: "literal", value: "one" },
    ]);
  });
});

describe("semantic primitive resource observations", () => {
  it.each([
    {
      name: "member",
      source: (large: string) =>
        `const answer = (${JSON.stringify(large)}).field;`,
    },
    {
      name: "destructuring",
      source: (large: string) =>
        `const { nested: { answer } } = { nested: ${JSON.stringify(large)} };`,
    },
  ])("preserves a limiting value through $name projection", ({ source }) => {
    const ir = analyzeJavaScriptSemantics(source("x".repeat(200_000)));
    expect(topLevelBinding(ir, "answer").value).toMatchObject({
      status: "unknown",
      resourceLimit: "primitive-bytes",
    });
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: ["primitive-bytes"],
    });
  });

  it("records an encountered bound without weakening a selected healthy sibling", () => {
    const ir = analyzeJavaScriptSemantics(
      `const answer = ({ ignored: ${JSON.stringify("x".repeat(200_000))}, kept: 7 }).kept;`,
    );
    expect(topLevelBinding(ir, "answer").value).toEqual({
      status: "literal",
      value: 7,
    });
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: ["primitive-bytes"],
    });
  });
});

describe("configuration default normalization", () => {
  it.each(["quoted", "template"])(
    "normalizes a bare %s configuration default",
    (syntax) => {
      const large = "x".repeat(200_000);
      const expression =
        syntax === "quoted" ? JSON.stringify(large) : `\`${large}\``;
      const ir = analyzeJavaScriptSemantics(
        `process.env.MODE ?? ${expression};`,
      );
      const operation = ir.configurationOperations.find(
        ({ kind }) => kind === "default",
      );
      expect(
        typeof operation?.value === "string" ? operation.value.length : 0,
      ).toBeLessThanOrEqual(174_762);
      expect(operation).toMatchObject({
        value: null,
        resolution: "partial",
        valueResourceLimit: "primitive-bytes",
      });
      expect(ir.coverage).toMatchObject({
        status: "partial",
        resourceLimits: ["primitive-bytes"],
      });
    },
  );

  it.each([null, false, 0, ""])(
    "keeps an exact bounded configuration default %j",
    (value) => {
      const ir = analyzeJavaScriptSemantics(
        `process.env.MODE ??
 ${JSON.stringify(value)};`,
      );
      expect(
        ir.configurationOperations.find(({ kind }) => kind === "default"),
      ).toMatchObject({ value, resolution: "complete" });
      expect(ir.coverage.resourceLimits ?? []).toEqual([]);
    },
  );
});

describe("semantic primitive allocation and binding reuse", () => {
  it.each(["quoted", "template"])(
    "applies the normalized byte boundary to %s literals",
    (syntax) => {
      // Six estimated JSON bytes per UTF-16 code unit plus two quotes:
      // 174762 code units fit; one more exceeds the 1 MiB bound.
      for (const length of [174_762, 174_763]) {
        const text = "x".repeat(length);
        const expression =
          syntax === "quoted" ? JSON.stringify(text) : `\`${text}\``;
        const ir = analyzeJavaScriptSemantics(`const answer = ${expression};`);
        const value = topLevelBinding(ir, "answer").value;
        if (length === 174_762) {
          expect(value.status).toBe("literal");
          expect(value).toMatchObject({ value: text });
        } else {
          expect(value).toMatchObject({
            status: "unknown",
            resourceLimit: "primitive-bytes",
          });
        }
      }
    },
  );

  it("shares an exact repeated primitive across bindings", () => {
    const ir = analyzeJavaScriptSemantics(
      'const a = "one"; const b = a; const c = a + "";',
    );
    for (const name of ["a", "b", "c"])
      expect(topLevelBinding(ir, name).value).toEqual({
        status: "literal",
        value: "one",
      });
  });

  it("drops repeated reads of a mutated binding to unknown", () => {
    const ir = analyzeJavaScriptSemantics(
      'let count = 0; count = count + 1; const answer = count;',
    );
    expect(topLevelBinding(ir, "answer").value).toMatchObject({
      status: "unknown",
    });
  });

  it("bounds the primitive union retained for a binding", () => {
    const ir = analyzeJavaScriptSemantics(
      "const answer = Array.from({ length: 512 }, (_, index) => index).join();",
    );
    expect(topLevelBinding(ir, "answer").value.status).toBe("unknown");
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: ["primitive-candidates"],
    });
  });

  it("bounds the primitive union retained for a template interpolation", () => {
    const choices = Array.from(
      { length: 10 },
      (_, index) => `(choice${String(index)} ? "v${String(index)}" : "w${String(index)}")`,
    ).join(" + ");
    const value = valueOf("`pre_${" + choices + "}_post`");
    expect(value.status).toBe("unknown");
    expect(value).toMatchObject({
      resourceLimit: "primitive-candidates",
    });
  });
});

describe("sampled primitive unions", () => {
  // Two chains of nine choices each give 2 * (2^9) = 1024 distinct leaf
  // candidates, so the retained set overflows the 256-candidate budget and
  // deterministic sampling kicks in.
  const sampledScopeExpression = [
    "(",
    Array.from(
      { length: 9 },
      (_, index) =>
        `(choice${String(index)} ? "l${String(index)}" : "r${String(index)}")`,
    ).join(" + "),
    ")",
  ].join("");
  const seenCount = 1024;

  it("returns a deterministic sample for a large addition product", () => {
    const left = Array.from(
      { length: 16 },
      (_, index) => `(left${String(index)} ? "a${String(index)}" : "b${String(index)}")`,
    ).join(" + ");
    const right = Array.from(
      { length: 16 },
      (_, index) => `(right${String(index)} ? "c${String(index)}" : "d${String(index)}")`,
    ).join(" + ");
    const first = valueOf(`${left} + ${right}`);
    const second = valueOf(`${left} + ${right}`);
    expect(first).toEqual(second);
    expect(first.status).toBe("union");
    if (first.status !== "union") throw new Error("Expected sampled union");
    expect(first.values).toHaveLength(256);
    expect(first.sampled).toEqual({
      method: "grid-product-stride-v1",
      seenCount: 65536,
    });
    expect(
      first.values.every(
        (candidate) => typeof candidate === "string" && /^[ad]\d+$/.test(candidate),
      ),
    ).toBe(true);
  });

  it("keeps the same sample regardless of candidate arrival order", () => {
    const left = Array.from(
      { length: 16 },
      (_, index) => `(left${String(index)} ? "a${String(index)}" : "b${String(index)}")`,
    ).join(" + ");
    const right = Array.from(
      { length: 16 },
      (_, index) => `(right${String(index)} ? "d${String(index)}" : "c${String(index)}")`,
    ).join(" + ");
    const first = valueOf(`${left} + ${right}`);
    const second = valueOf(`${left} + ${right}`);
    expect(first).toEqual(second);
  });

  it("bounds derived single-string growth before concatenation or key serialization", () => {
    const value = valueOf("`${" + sampledScopeExpression + "}`");
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected sampled union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled).toEqual({
      method: "systematic-candidate-stride-v1",
      seenCount: 1024,
    });
  });

  it("memoizes by resolved binding without crossing shadowing or mutation", () => {
    const ir = analyzeJavaScriptSemantics(
      'const x = "one"; { let x = "two"; x; } const answer = x;',
    );
    expect(topLevelBinding(ir, "answer").value).toEqual({
      status: "literal",
      value: "one",
    });
  });

  it("retains a large derived string while its aggregate JSON estimate fits", () => {
    // A single 174762-code-unit string fits the byte budget exactly, so the
    // candidate limit alone must not reject it.
    const text = "x".repeat(174_762);
    const value = valueOf(`${JSON.stringify(text)}`);
    expect(value).toMatchObject({ status: "literal", value: text });
  });

  it("retains exact candidates for a near-budget Cartesian workload", () => {
    // 16 x 16 = 256 pairs stay inside the candidate budget.
    const pairs = [
      '(p0 ? "a" : "b") + (q0 ? "1" : "2")',
      '(p1 ? "c" : "d") + (q1 ? "3" : "4")',
      '(p2 ? "e" : "f") + (q2 ? "5" : "6")',
      '(p3 ? "g" : "h") + (q3 ? "7" : "8")',
      '(p4 ? "i" : "j") + (q4 ? "9" : "0")',
      '(p5 ? "k" : "l") + (q5 ? "x" : "y")',
      '(p6 ? "m" : "n") + (q6 ? "z" : "w")',
      '(p7 ? "o" : "p") + (q7 ? "v" : "u")',
      '(p8 ? "r" : "s") + (q8 ? "t" : "q")',
      '(p9 ? "aa" : "ab") + (q9 ? "ac" : "ad")',
      '(pa ? "ae" : "af") + (qa ? "ag" : "ah")',
      '(pb ? "ai" : "aj") + (qb ? "ak" : "al")',
      '(pc ? "am" : "an") + (qc ? "ao" : "ap")',
      '(pd ? "aq" : "ar") + (qd ? "as" : "at")',
      '(pe ? "au" : "av") + (qe ? "aw" : "ax")',
      '(pf ? "ay" : "az") + (qf ? "ba" : "bb")',
    ];
    const value = valueOf(`(${pairs.join(") + (")})`);
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected exact union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled).toBeUndefined();
  });

  it("retains a deterministic sample with provenance instead of dropping to unknown", () => {
    const value = valueOf(`${sampledScopeExpression}`);
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected sampled union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled).toEqual({
      method: "systematic-candidate-stride-v1",
      seenCount,
    });
    expect(ir.coverage.resourceLimits ?? []).toEqual([]);
  });

  it("keeps the explicit unknown past the hard sample scope", () => {
    const value = semanticPrimitiveSet(
      Array.from({ length: SEMANTIC_PRIMITIVE_SAMPLE_SCOPE_LIMIT + 1 }, (_, i) => i),
    );
    expect(value).toMatchObject({
      status: "unknown",
      resourceLimit: "primitive-candidates",
    });
  });

  it("does not record a resource limit when analysis returns a sampled union", () => {
    const ir = analyzeJavaScriptSemantics(
      `const answer = ${sampledScopeExpression};`,
    );
    const value = topLevelBinding(ir, "answer").value;
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected sampled union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled).toEqual({
      method: "systematic-candidate-stride-v1",
      seenCount,
    });
    expect(ir.coverage.resourceLimits ?? []).toEqual([]);
  });

  it("samples template interpolation products past the candidate budget", () => {
    const spread = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `(choice${prefix}${String(index)} ? "${prefix}${String(index)}" : "${prefix}x${String(index)}")`,
      ).join(" + ");
    // Nine pairwise choices give 2^9 = 512 distinct interpolated suffixes.
    const expression = "`pre_${" + spread("a", 9) + "}_post`";
    const value = valueOf(expression);
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected sampled union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled?.method).toBe("systematic-candidate-stride-v1");
    expect(value.sampled?.seenCount).toBe(512);
    expect(
      value.values.every(
        (candidate) =>
          typeof candidate === "string" &&
          candidate.startsWith("pre_a") &&
          candidate.endsWith("_post"),
      ),
    ).toBe(true);
  });

  it("does not let a sampled union decide a conditional branch", () => {
    // Every retained sample value is truthy, but omitted candidates could be
    // falsy, so both branches must survive.
    const value = valueOf(`${sampledScopeExpression} ? "x" : "y"`);
    expect(value).toEqual({ status: "union", values: ["x", "y"] });
  });

  it("keeps sampled provenance when a unary collapses the sample", () => {
    const value = valueOf(`!${sampledScopeExpression}`);
    expect(value).toMatchObject({
      status: "union",
      values: [false],
      sampled: { method: "systematic-candidate-stride-v1", seenCount: 402 },
    });
  });

  it("keeps honest scope accounting across repeated sampled interpolations", () => {
    const pairs = (prefix: string) =>
      Array.from(
        { length: 9 },
        (_, index) =>
          `(choice${prefix}${String(index)} ? "${prefix}${String(index)}" : "${prefix}x${String(index)}")`,
      ).join(" + ");
    // Two sampled interpolations: 2^9 * 2^9 = 262144 observed candidates.
    const value = valueOf("`${" + pairs("a") + "}_${" + pairs("b") + "}`");
    expect(value.status).toBe("union");
    if (value.status !== "union") throw new Error("Expected sampled union");
    expect(value.values).toHaveLength(256);
    expect(value.sampled).toEqual({
      method: "systematic-candidate-stride-v1",
      seenCount: 262_144,
    });
  });

  it("rejects nonfinite sampled sums like the exact path", () => {
    // Seventeen distinct finite magnitudes per side give 289 pairs, so the
    // addition samples its product; every sum overflows to Infinity.
    const numbers = (prefix: string) => {
      let expression = "1.16e308";
      for (let index = 15; index >= 0; index -= 1)
        expression = `(choice${prefix}${String(index)} ? ${(1 + index / 100).toFixed(2)}e308 : ${expression})`;
      return expression;
    };
    const value = valueOf(`${numbers("l")} + ${numbers("r")}`);
    expect(value.status).toBe("unknown");
    expect(value).toMatchObject({
      reason: expect.stringMatching(/Nonfinite/i),
    });
  });

  it("bounds sampled template output before retaining it", () => {
    // The static prefix alone sits just under the byte budget; one combined
    // sampled string exceeds it, so no sampled evidence is retained.
    const prefix = "p".repeat(174_762);
    const value = valueOf("`" + prefix + "${" + sampledScopeExpression + "}`");
    expect(value).toMatchObject({
      status: "unknown",
      resourceLimit: "primitive-bytes",
    });
  });
});

describe("semantic expression depth bounds", () => {
  it("returns an explicit unknown for a deeply nested unary AST without throwing", () => {
    const parsed = parseJavaScriptSource("const answer = true;");
    const declaration = parsed?.program.body[0];
    const declarator = t.isVariableDeclaration(declaration)
      ? declaration.declarations[0]
      : undefined;
    if (parsed === null || !t.isVariableDeclarator(declarator))
      throw new Error("Expected parsed binding initializer");
    let expression: t.Expression = t.booleanLiteral(true);
    for (let index = 0; index < 5_000; index += 1)
      expression = t.unaryExpression("!", expression, true);
    declarator.init = expression;

    const ir = analyzeParsedJavaScriptSemantics(parsed);
    expect(ir.coverage).toMatchObject({
      status: "partial",
      omittedCount: null,
      resourceLimits: ["expression-depth"],
    });
    expect(topLevelBinding(ir, "answer").value).toEqual({
      status: "unknown",
      resourceLimit: "expression-depth",
      reason: expect.stringMatching(
        /semantic expression depth budget exceeded/i,
      ),
    });
  });

  it("bounds nested conditional evaluation and provenance walks", () => {
    const parsed = parseJavaScriptSource("const answer = true;");
    const declaration = parsed?.program.body[0];
    const declarator = t.isVariableDeclaration(declaration)
      ? declaration.declarations[0]
      : undefined;
    if (parsed === null || !t.isVariableDeclarator(declarator))
      throw new Error("Expected parsed binding initializer");
    let expression: t.Expression = t.booleanLiteral(true);
    for (let index = 0; index < 5_000; index += 1)
      expression = t.conditionalExpression(
        t.identifier("condition"),
        expression,
        t.booleanLiteral(false),
      );
    declarator.init = expression;

    const ir = analyzeParsedJavaScriptSemantics(parsed);
    const value = topLevelBinding(ir, "answer").value;
    expect(value).toMatchObject({
      status: "unknown",
      resourceLimit: "expression-depth",
      reason: expect.stringMatching(
        /semantic expression depth budget exceeded/i,
      ),
    });
  });

  it("counts erased TypeScript wrappers on a return against expression depth", () => {
    const source = "function answer() { return true; }";
    const parsed = parseJavaScriptSource(source);
    const declaration = parsed?.program.body[0];
    const statement = t.isFunctionDeclaration(declaration)
      ? declaration.body.body[0]
      : undefined;
    const argument = t.isReturnStatement(statement)
      ? statement.argument
      : undefined;
    if (parsed === null || !t.isReturnStatement(statement) || argument == null)
      throw new Error("Expected a returned value");
    let expression = argument;
    for (let index = 0; index < 300; index += 1)
      expression = t.tsAsExpression(expression, t.tsBooleanKeyword());
    statement.argument = expression;

    const ir = analyzeParsedJavaScriptSemantics(parsed);
    const site = ir.callables.find((item) => item.name === "answer")
      ?.returnSites[0];
    expect(site?.value).toMatchObject({
      status: "unknown",
      resourceLimit: "expression-depth",
    });
    const literalStart = source.indexOf("true");
    expect(site?.valueExpressionLocation).toEqual({
      start: { line: 1, column: literalStart },
      end: { line: 1, column: literalStart + "true".length },
    });
  });

  it("counts erased TypeScript wrappers against expression depth", () => {
    const parsed = parseJavaScriptSource("const answer = true;");
    const declaration = parsed?.program.body[0];
    const declarator = t.isVariableDeclaration(declaration)
      ? declaration.declarations[0]
      : undefined;
    if (parsed === null || !t.isVariableDeclarator(declarator))
      throw new Error("Expected parsed binding initializer");
    let expression: t.Expression = t.booleanLiteral(true);
    for (let index = 0; index < 300; index += 1)
      expression = t.tsAsExpression(expression, t.tsStringKeyword());
    declarator.init = expression;

    const ir = analyzeParsedJavaScriptSemantics(parsed);
    expect(topLevelBinding(ir, "answer").value).toMatchObject({
      status: "unknown",
      resourceLimit: "expression-depth",
    });
  });

  it("preserves exact shallow addition alternatives", () => {
    expect(valueOf('(choice ? "a" : "b") + (other ? "1" : "2")')).toEqual({
      status: "union",
      values: ["a1", "a2", "b1", "b2"],
    });
  });
});