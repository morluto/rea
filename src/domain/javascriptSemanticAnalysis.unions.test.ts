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

  it.each(cases)("preserves incompatible alternatives in %s", (expression) => {
    expect(valueOf(expression)).toEqual(incompatibleValue);
  });

  it.each([
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
  ])("retains exact primitive candidates in %s", (expression, expected) => {
    expect(valueOf(expression)).toEqual(expected);
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

  it.each(cases)("preserves unresolved alternatives in %s", (expression) => {
    expect(valueOf(expression)).toEqual(incompatibleValue);
  });

  it.each([
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
  ])(
    "retains the conservative primitive union in %s",
    (expression, expected) => {
      expect(valueOf(expression)).toEqual(expected);
    },
  );

  it.each([
    'true ? "one" : missing',
    '"one" || missing',
    "false && missing",
    '"one" ?? missing',
  ])("does not introduce short-circuit evaluation for %s", (expression) => {
    expect(valueOf(expression)).toEqual(incompatibleValue);
  });
});
