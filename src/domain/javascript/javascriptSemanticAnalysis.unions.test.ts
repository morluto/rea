import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";

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

  it("does not introduce short-circuit evaluation", () => {
    expect(valuesOf(unevaluatedCases)).toEqual(
      unevaluatedCases.map(() => incompatibleValue),
    );
  });
});
