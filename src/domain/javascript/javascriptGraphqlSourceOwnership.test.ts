import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

it.each([
  [
    "direct marker",
    'locationOffset:{line:1,column:1},body:"query Old { x }",body:"query Current { x }"',
    ["Current"],
  ],
  [
    "marker in an inline spread",
    '...{locationOffset:{line:1,column:1}},body:"query Old { x }",body:"query Current { x }"',
    ["Current"],
  ],
  [
    "marker in nested inline spreads",
    '...{...{locationOffset:{line:1,column:1}}},body:"query Old { x }",body:"query Current { x }"',
    ["Current"],
  ],
  [
    "overwritten Source in an inline spread",
    '...{locationOffset:{line:1,column:1},body:"query Old { x }"},body:"query Current { x }"',
    ["Current"],
  ],
  [
    "unknown final body after an inline Source",
    '...{locationOffset:{line:1,column:1},body:"query Old { x }"},...runtimeOptions',
    [],
  ],
  [
    "nested inline Sources with an unrelated nested Source",
    '...{...{locationOffset:{line:1,column:1},body:"query Old { x }"},body:"query Middle { x }"},body:"query Current { x }",metadata:{locationOffset:{line:1,column:1},body:"query Independent { x }"}',
    ["Current", "Independent"],
  ],
  [
    "unknown later body with an owned marker",
    'locationOffset:{line:1,column:1},body:"query Old { x }",...runtimeOptions',
    [],
  ],
  [
    "ordinary nested metadata",
    'metadata:{locationOffset:{line:1,column:1}},body:"query Plain { x }"',
    ["Plain"],
  ],
  [
    "unknown computed property after the body",
    'locationOffset:{line:1,column:1},body:"query Old { x }",[key]:runtimeValue',
    [],
  ],
] as const)(
  "preserves Source body ownership for %s",
  (_name, fields, expected) => {
    const result = analyzeJavaScriptStaticSource(`const source={${fields}};`);
    expect(
      result.endpoints
        .filter(({ mechanism }) => mechanism === "graphql:query")
        .map(({ value }) => value),
    ).toEqual(expected);
  },
);
