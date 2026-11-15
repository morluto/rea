import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { schemaSubschemas } from "./jsonSchemaKeywords.js";
import {
  INLINE_ALTERNATIVE_BYTES,
  shareOutputDefinitions,
} from "./outputSchemaDefinitions.js";
import { ANALYSIS_VIEW_TOOL_CONTRACTS } from "./analysisViewToolContracts.js";
import { advertisedOutputJsonSchema } from "./toolSchemaMetadata.js";
import { isRecord } from "../domain/isRecord.js";

// An object alternative whose serialized size exceeds the inline bound.
const largeAlternative = (kind: string, reference: string) => ({
  type: "object",
  properties: {
    kind: { type: "string", const: kind },
    value: { $ref: reference },
    ...Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field_${index}`,
        { type: "integer", minimum: index },
      ]),
    ),
  },
  required: ["kind", "value"],
  additionalProperties: false,
});

const unionSchema = (definitions: "$defs" | "definitions") => {
  const reference = `#/${definitions}/text`;
  return {
    type: "object",
    properties: {
      result: {
        anyOf: [
          largeAlternative("first", reference),
          largeAlternative("second", reference),
          { type: "null" },
        ],
      },
    },
    required: ["result"],
    [definitions]: { text: { type: "string", minLength: 2 } },
  };
};

const inlineAlternatives = (schema: unknown): number[] => {
  if (!isRecord(schema)) return [];
  const own = ["anyOf", "oneOf"].flatMap((keyword) => {
    const alternatives = schema[keyword];
    return Array.isArray(alternatives)
      ? alternatives
          .filter(
            (alternative) => isRecord(alternative) && !("$ref" in alternative),
          )
          .map((alternative) => JSON.stringify(alternative).length)
      : [];
  });
  return [
    ...own,
    ...schemaSubschemas(schema, { includeDefinitions: true }).flatMap(
      inlineAlternatives,
    ),
  ];
};

const samples = [
  { result: null },
  { result: { kind: "first", value: "ok" } },
  { result: { kind: "second", value: "ok", field_3: 3 } },
  { result: { kind: "first", value: "x" } },
  { result: { kind: "third", value: "ok" } },
  { result: { kind: "second", value: "ok", field_3: 2 } },
  { result: { kind: "second", value: "ok", extra: true } },
  {},
];

describe("shareOutputDefinitions", () => {
  it.each([
    ["$defs", () => new Ajv2020({ strict: false })],
    ["definitions", () => new Ajv({ strict: false })],
  ] as const)(
    "moves large alternatives into %s without changing validation",
    (definitions, ajv) => {
      const original = unionSchema(definitions);
      const shared = shareOutputDefinitions(structuredClone(original));
      const alternatives = (
        (shared.properties as Record<string, Record<string, unknown>>).result!
          .anyOf as unknown[]
      ).map((alternative) => JSON.stringify(alternative));
      expect(alternatives).toEqual([
        `{"$ref":"#/${definitions}/__branch0"}`,
        `{"$ref":"#/${definitions}/__branch1"}`,
        '{"type":"null"}',
      ]);
      expect(Math.max(...inlineAlternatives(shared))).toBeLessThanOrEqual(
        INLINE_ALTERNATIVE_BYTES,
      );
      const before = ajv().compile(original);
      const after = ajv().compile(shared);
      expect(samples.map((sample) => after(sample))).toEqual(
        samples.map((sample) => before(sample)),
      );
      expect(samples.map((sample) => before(sample))).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
    },
  );

  it("merges identical definitions, including those identical only after a merge", () => {
    const shared = shareOutputDefinitions({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/outerA" },
        b: { $ref: "#/$defs/outerB" },
      },
      $defs: {
        innerA: { type: "integer", minimum: 1 },
        innerB: { type: "integer", minimum: 1 },
        outerA: { type: "array", items: { $ref: "#/$defs/innerA" } },
        outerB: { type: "array", items: { $ref: "#/$defs/innerB" } },
        // Same keywords as innerA but a different value: kept.
        other: { type: "integer", minimum: 2 },
      },
    });
    expect(shared).toEqual({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/outerA" },
        b: { $ref: "#/$defs/outerA" },
      },
      $defs: {
        innerA: { type: "integer", minimum: 1 },
        outerA: { type: "array", items: { $ref: "#/$defs/innerA" } },
        other: { type: "integer", minimum: 2 },
      },
    });
  });

  it("keeps instance values and unknown keywords as data", () => {
    const literal = { $ref: "#/$defs/second" };
    const shared = shareOutputDefinitions({
      type: "object",
      properties: {
        first: { $ref: "#/$defs/first" },
        second: { $ref: "#/$defs/second" },
        marker: { const: literal, default: literal },
      },
      "x-note": { $ref: "#/$defs/second" },
      $defs: { first: { type: "string" }, second: { type: "string" } },
    });
    expect(shared).toEqual({
      type: "object",
      properties: {
        first: { $ref: "#/$defs/first" },
        second: { $ref: "#/$defs/first" },
        marker: { const: literal, default: literal },
      },
      "x-note": { $ref: "#/$defs/second" },
      $defs: { first: { type: "string" } },
    });
  });

  it("names a moved alternative apart from existing definitions", () => {
    const original = unionSchema("$defs");
    const shared = shareOutputDefinitions({
      ...original,
      $defs: { text: { type: "string" }, __branch0: { type: "boolean" } },
    });
    expect(Object.keys(shared.$defs as object)).toEqual([
      "text",
      "__branch0",
      "__branch1",
      "__branch2",
    ]);
  });

  it.each([
    ["an embedded resource", { $id: "https://example.test/nested" }],
    ["an anchor", { $anchor: "nested" }],
    ["a dynamic reference", { $dynamicRef: "#nested" }],
    ["a pointer outside the definitions", { $ref: "#/properties/result" }],
    ["an external reference", { $ref: "other.json#/$defs/text" }],
    ["an unknown definition", { $ref: "#/$defs/missing" }],
    ["an escaped pointer", { $ref: "#/$defs/te~1xt" }],
  ])("returns a schema with %s unchanged", (_, extra) => {
    const original = unionSchema("$defs");
    const schema = {
      ...original,
      properties: { ...original.properties, extra },
    };
    expect(shareOutputDefinitions(schema)).toBe(schema);
  });

  it("returns a schema without one definition map unchanged", () => {
    const original = unionSchema("$defs");
    const both = { ...original, definitions: {} };
    expect(shareOutputDefinitions(both)).toBe(both);
    const { $defs: _, ...none } = original;
    expect(shareOutputDefinitions(none)).toBe(none);
  });
});

// Its results are validated against this schema in analysisDetail.test.ts and
// BrowserScenarioViews.test.ts.
it("advertises the analysis view output without large inline alternatives", () => {
  const contract = ANALYSIS_VIEW_TOOL_CONTRACTS.find(
    ({ name }) => name === "inspect_analysis_view",
  );
  if (contract === undefined)
    throw new Error("Missing inspect_analysis_view contract");
  const schema = advertisedOutputJsonSchema(contract);
  expect(Math.max(...inlineAlternatives(schema))).toBeLessThanOrEqual(
    INLINE_ALTERNATIVE_BYTES,
  );
});
