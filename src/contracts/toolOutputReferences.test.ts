import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { inlineLocalJsonSchemaReferences } from "../../tests/fixtures/localJsonSchemaReferences.js";
import { toolContract } from "./toolContracts.js";
import { toolOutputSchemaWithMetadata } from "./toolSchemaMetadata.js";

it.each(["draft-2020-12", "draft-07"] as const)(
  "preserves refined numeric bounds and strict repeated objects through %s references",
  (target) => {
    const integer = z.number().int().nonnegative();
    const range = z
      .object({
        offset: integer.max(65535),
        length: integer.min(1),
        exclusive: integer.positive(),
      })
      .strict();
    const canonical = z.object({ before: range, after: range }).strict();
    const advertised = toolOutputSchemaWithMetadata({
      ...toolContract("open_binary"),
      outputSchema: canonical,
    })["~standard"].jsonSchema.output({ target });
    const ajv =
      target === "draft-2020-12"
        ? new Ajv2020({ strict: false })
        : new Ajv({ strict: false });
    const validate = ajv.compile(advertised);
    const valid = {
      before: { offset: 0, length: 1, exclusive: 1 },
      after: { offset: 65535, length: 9007199254740991, exclusive: 1 },
    };
    const samples: readonly unknown[] = [
      valid,
      ...[
        { offset: -1 },
        { offset: 65536 },
        { offset: 0.5 },
        { length: 0 },
        { length: 9007199254740992 },
        { exclusive: 0 },
        { exclusive: -1 },
        { length: null },
        { unexpected: true },
      ].map((change) => ({ ...valid, before: { ...valid.before, ...change } })),
      { ...valid, before: { offset: 0, exclusive: 1 } },
      { ...valid, after: null },
      { ...valid, unexpected: true },
    ];
    expect(canonical.safeParse(valid).success).toBe(true);
    for (const sample of samples)
      expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    expect(inlineLocalJsonSchemaReferences(advertised)).toEqual(
      inlineLocalJsonSchemaReferences(
        canonical["~standard"].jsonSchema.output({ target }),
      ),
    );
  },
);

it("keeps schema data containing reference-shaped objects untouched", () => {
  const literal = { $ref: "https://example.invalid/value" };
  const expanded = inlineLocalJsonSchemaReferences({
    $defs: {
      "a/b": {
        type: "object",
        properties: { $defs: { const: literal } },
        examples: [literal],
      },
    },
    $ref: "#/$defs/a~1b",
    description: "Keep the caller-facing annotation",
  });
  expect(expanded).toEqual({
    type: "object",
    properties: { $defs: { const: literal } },
    examples: [literal],
    description: "Keep the caller-facing annotation",
  });
});

it.each(["draft-2020-12", "draft-07"] as const)(
  "preserves layered native-selector string patterns through %s references",
  (target) => {
    const selector = z
      .string()
      .min(1)
      .regex(/^[^\0]*$/u)
      .regex(/^[^\s[\]]+$/u);
    const canonical = z.object({ before: selector, after: selector }).strict();
    const advertised = toolOutputSchemaWithMetadata({
      ...toolContract("open_binary"),
      outputSchema: canonical,
    })["~standard"].jsonSchema.output({ target });
    const ajv =
      target === "draft-2020-12"
        ? new Ajv2020({ strict: false })
        : new Ajv({ strict: false });
    const validate = ajv.compile(advertised);
    for (const value of [
      "setFoo:",
      "dataTaskWithRequest:completionHandler:",
      "",
      "set\0Foo:",
      "bad selector:",
      "bad[selector]:",
    ]) {
      const sample = { before: value, after: "setFoo:" };
      expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    }
    expect(inlineLocalJsonSchemaReferences(advertised)).toEqual(
      inlineLocalJsonSchemaReferences(
        canonical["~standard"].jsonSchema.output({ target }),
      ),
    );
  },
);

it("rejects unresolved and cyclic references rather than concealing schema drift", () => {
  expect(() =>
    inlineLocalJsonSchemaReferences({ $ref: "#/$defs/missing" }),
  ).toThrow("Missing schema reference");
  expect(() =>
    inlineLocalJsonSchemaReferences({
      $defs: { loop: { $ref: "#/$defs/loop" } },
      $ref: "#/$defs/loop",
    }),
  ).toThrow("Recursive schema reference");
});

it("intersects referenced numeric bounds and rejects conflicting validation keywords", () => {
  expect(
    inlineLocalJsonSchemaReferences({
      $defs: { bounded: { type: "number", minimum: 1, maximum: 10 } },
      $ref: "#/$defs/bounded",
      minimum: 0,
      maximum: 9,
    }),
  ).toEqual({ type: "number", minimum: 1, maximum: 9 });
  expect(() =>
    inlineLocalJsonSchemaReferences({
      $defs: { strict: { type: "object" } },
      $ref: "#/$defs/strict",
      type: "string",
    }),
  ).toThrow("Conflicting schema reference sibling: type");
});

it("preserves strict-object evaluation scope across references and singleton intersections", () => {
  const strict = {
    type: "object",
    properties: { value: { type: "string" } },
    additionalProperties: false,
  };
  const schemas = [
    {
      $defs: { strict },
      $ref: "#/$defs/strict",
      additionalProperties: false,
    },
    { allOf: [strict], additionalProperties: false },
  ];
  for (const schema of schemas) {
    const expanded = z
      .record(z.string(), z.unknown())
      .parse(inlineLocalJsonSchemaReferences(schema));
    const ajv = new Ajv2020({ strict: false });
    const original = ajv.compile(schema);
    const normalized = ajv.compile(expanded);
    expect(original({})).toBe(true);
    expect(original({ value: "kept" })).toBe(false);
    for (const sample of [{}, { value: "kept" }, { unexpected: true }, null])
      expect(normalized(sample)).toBe(original(sample));
  }
});
