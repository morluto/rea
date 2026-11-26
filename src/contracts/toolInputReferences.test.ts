import { Ajv, type Options } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { applicationFeatureSeedSchema } from "../domain/javascript/javascriptFeatureTraceSchemas.js";
import { ADVERTISED_INPUT_SCHEMA_MAX_BYTES } from "./advertisedDialect.js";
import { advertiseToolInput } from "./advertisedTool.js";
import { presentAdvertisedInput } from "./compactInputSchema.js";
import { presentInputJsonSchema } from "./inputSchemaPresentation.js";
import { ANALYSIS_VIEW_TOOL_CONTRACTS } from "./analysisViewToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "./native/nativeToolContracts.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "./reverseEngineeringToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "./sessionToolContracts.js";
import type { ToolContract } from "./toolContractTypes.js";
import {
  toolInputSchemaWithMetadata,
  transformAdvertisedInputJsonSchema,
} from "./toolSchemaMetadata.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "./javascript/javascriptRuntimeReconciliationExample.js";

const drafts = ["draft-2020-12", "draft-07"] as const;
type Draft = (typeof drafts)[number];
const validatorFor = (target: Draft = "draft-2020-12", options: Options = {}) =>
  target === "draft-2020-12"
    ? new Ajv2020({ strict: false, ...options })
    : new Ajv({ strict: false, ...options });

const contractFrom = (family: readonly ToolContract[], name: string) => {
  const contract = family.find((entry) => entry.name === name);
  if (contract === undefined)
    throw new Error(`Missing test contract for ${name}`);
  return contract;
};

/** The input schema a client receives: presentation, then the portable dialect. */
const advertise = (canonical: Record<string, unknown>) =>
  advertiseToolInput(
    undefined,
    presentInputJsonSchema(canonical, () => undefined),
    { budgetBytes: ADVERTISED_INPUT_SCHEMA_MAX_BYTES },
  ).inputSchema;

it.each(drafts)(
  "honors projection options independently of cached wire transformations in %s",
  (target) => {
    const range = z.strictObject({ offset: z.number(), length: z.number() });
    const canonical = z.strictObject({ before: range, after: range });
    const transform = (schema: Record<string, unknown>) => ({
      ...schema,
      title: "Transformed range inputs",
    });
    const options = { target, libraryOptions: { reused: "ref" as const } };
    for (const sharedFirst of [false, true]) {
      const seed = transform(
        canonical["~standard"].jsonSchema.input({ target }),
      );
      const resolveCached = vi.fn(() => seed);
      const wrapped = transformAdvertisedInputJsonSchema(
        canonical,
        transform,
        resolveCached,
      );
      const project = wrapped["~standard"].jsonSchema.input;
      if (sharedFirst) {
        project(options);
        expect(resolveCached).not.toHaveBeenCalled();
      }
      const advertised = project({ target });
      expect(advertised).toBe(seed);
      expect(JSON.stringify(advertised)).not.toContain('"$ref":');
      expect(advertised).toEqual(
        transform(canonical["~standard"].jsonSchema.input({ target })),
      );
      const shared = project(options);
      expect(JSON.stringify(shared)).toContain('"$ref":');
      expect(shared).toEqual(
        transform(canonical["~standard"].jsonSchema.input(options)),
      );
      expect(project({ target })).toBe(advertised);
      expect(resolveCached).toHaveBeenCalledExactlyOnceWith(target);
    }
  },
);

it.each(drafts)(
  "preserves the complete inline Evidence contract before deferred authentication in %s",
  (target) => {
    const schema = toolInputSchemaWithMetadata(
      contractFrom(ANALYSIS_VIEW_TOOL_CONTRACTS, "inspect_analysis_view"),
    )["~standard"].jsonSchema.input({ target });
    const ajv = validatorFor(target, { validateFormats: false });
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    const input = {
      source: {
        kind: "inline",
        evidence: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
      },
      view: { kind: "summary" },
    };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...input, source: { kind: "inline", evidence: {} } }),
    ).toBe(false);
    expect(validate({ ...input, source: { kind: "inline" } })).toBe(false);
  },
);

it.each(drafts)(
  "keeps objdump Unicode validation and portable SDK patterns in %s",
  (target) => {
    const canonical = toolInputSchemaWithMetadata(
      contractFrom(REVERSE_ENGINEERING_TOOL_CONTRACTS, "inspect_with_objdump"),
    );
    const schema = canonical["~standard"].jsonSchema.input({ target });
    const input = { path: "sample.elf", operation: "disassemble" };
    for (const unicodeRegExp of [false, true]) {
      const ajv = validatorFor(target, {
        validateFormats: false,
        unicodeRegExp,
      });
      expect(ajv.validateSchema(schema)).toBe(true);
      const validate = ajv.compile(schema);
      for (const symbol of [
        "known_function",
        "selector_\u{1F680}",
        "selector_\uFFFD",
      ]) {
        expect(
          validate({ ...input, symbol }),
          JSON.stringify(validate.errors),
        ).toBe(true);
        expect(canonical.safeParse({ ...input, symbol }).success).toBe(true);
      }
      expect(validate({ ...input, symbol: "a\u0000b" })).toBe(false);
    }
    // Scalar Unicode engines cannot express unpaired UTF-16 surrogates. The
    // registered canonical validator owns that runtime constraint.
    for (const symbol of [
      "\ud800",
      "\udc00",
      "prefix\ud800suffix",
      "\udc00\ud800",
    ])
      expect(canonical.safeParse({ ...input, symbol }).success).toBe(false);
  },
);

describe("advertised object dependencies", () => {
  it.each([
    ["draft-07", "dependencies"],
    ["draft-2020-12", "dependentRequired"],
  ] as const)(
    "presents object-group dependencies as guidance without unsupported dialect keywords (%s)",
    (dialect, dependencyKeyword) => {
      const canonical = presentInputJsonSchema(
        {
          $schema:
            dialect === "draft-07"
              ? "http://json-schema.org/draft-07/schema#"
              : "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { url: { type: "string" }, body: { type: "string" } },
          required: ["body"],
          [dependencyKeyword]: { body: ["url"] },
        },
        () => undefined,
      );
      // The registered schema keeps the canonical keyword; the listed schema
      // states it in the tool guidance instead.
      expect(canonical).toHaveProperty([dependencyKeyword, "body"], ["url"]);
      const { schema, guidance } = presentAdvertisedInput(canonical, {
        budgetBytes: ADVERTISED_INPUT_SCHEMA_MAX_BYTES,
      });
      expect(schema).not.toHaveProperty("dependencies");
      expect(schema).not.toHaveProperty("dependentRequired");
      expect(guidance).toContain("When body is provided, also provide url.");
    },
  );
});

describe("advertised production selector contracts", () => {
  it.each(drafts)(
    "preserves production native-selector constraints in %s",
    (target) => {
      const contract = contractFrom(
        NATIVE_TOOL_CONTRACTS,
        "observe_native_calls",
      );
      const advertised = toolInputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.input({ target });
      const ajv = validatorFor(target);
      const validate = ajv.compile(advertised);
      for (const [selector, accepted] of [
        ["setFoo:", true],
        ["dataTaskWithRequest:completionHandler:", true],
        ["", false],
        ["bad selector:", false],
        ["bad[selector]:", false],
        ["set\0Foo:", false],
        ["setFoo:\n", false],
      ] as const) {
        const sample = {
          breakpoints: [
            { kind: "objc-method", class_name: "NSURLSession", selector },
          ],
        };
        expect(
          contract.inputSchema.safeParse(sample).success,
          JSON.stringify(selector),
        ).toBe(accepted);
        expect(validate(sample), JSON.stringify(selector)).toBe(accepted);
      }
      const unexpected = {
        breakpoints: [
          {
            kind: "objc-method",
            class_name: "NSURLSession",
            selector: "setFoo:",
            unexpected: true,
          },
        ],
      };
      expect(contract.inputSchema.safeParse(unexpected).success).toBe(false);
      expect(validate(unexpected)).toBe(false);
    },
  );
});

describe("advertised schema metadata and validation", () => {
  it.each(drafts)(
    "retains specialized descriptions, literal metadata and strict validation in %s",
    (target) => {
      const literal = {
        properties: { target: { $ref: "literal caller data" } },
        examples: [{ properties: { path: {} } }],
      };
      const range = z
        .object({
          offset: z.number().int().nonnegative().max(65535),
          length: z.number().int().min(1),
        })
        .strict()
        .describe("Exact byte range in the selected artifact.");
      const canonical = z
        .object({
          before: range,
          after: range,
          metadata: z
            .record(z.string(), z.unknown())
            .meta({ default: literal, examples: [literal] }),
          constructor: z.string(),
        })
        .strict();
      const project = toolInputSchemaWithMetadata({
        ...contractFrom(SESSION_TOOL_CONTRACTS, "open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input;
      const advertised = project({ target });
      const inline = project({ target, libraryOptions: { reused: "inline" } });
      expect(inline).toMatchObject({
        properties: {
          before: { description: "Exact byte range in the selected artifact." },
          after: { description: "Exact byte range in the selected artifact." },
          metadata: { default: literal, examples: [literal] },
        },
      });
      // Inherited object keys never supply a description.
      expect(inline).not.toHaveProperty([
        "properties",
        "constructor",
        "description",
      ]);
      const ajv = validatorFor(target);
      const validate = ajv.compile(advertised);
      const valid = {
        before: { offset: 0, length: 1 },
        after: { offset: 65535, length: 2 },
        metadata: literal,
        constructor: "constructor data",
      };
      const samples = [
        valid,
        ...[
          { offset: -1 },
          { offset: 65536 },
          { offset: 0.5 },
          { length: 0 },
          { unexpected: true },
        ].map((change) => ({
          ...valid,
          before: { ...valid.before, ...change },
        })),
        { ...valid, after: null },
        { ...valid, unexpected: true },
      ];
      expect(canonical.safeParse(valid).success).toBe(true);
      for (const sample of samples)
        expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    },
  );
});

describe("root input presentation", () => {
  it("preserves prototype-named properties in object-root presentation", () => {
    const fields = Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["constructor", { type: "number" }],
    ]);
    const branch = {
      type: "object",
      properties: fields,
      required: ["__proto__"],
      additionalProperties: false,
    };
    const presented = presentInputJsonSchema(
      { anyOf: [branch, branch] },
      (property) => `Parameter ${property}`,
    );
    expect(presented).not.toHaveProperty("anyOf");
    expect(presented).toMatchObject({
      type: "object",
      required: ["__proto__"],
      additionalProperties: false,
    });
    const properties = presented.properties;
    if (typeof properties !== "object" || properties === null)
      throw new Error("Missing root properties");
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
  });

  it.each(drafts)(
    "advertises complete root groups while runtime keeps the exact union in %s",
    (target) => {
      const schema = z.union([
        z.strictObject({ before: z.string(), after: z.string() }),
        z.strictObject({
          before_scenario: z.number(),
          after_scenario: z.number(),
          normalization: z.boolean().optional(),
        }),
      ]);
      const canonical = z.toJSONSchema(schema, { io: "input", target });
      const advertised = presentInputJsonSchema(
        canonical,
        (property) => property,
      );
      // Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root.
      for (const combinator of ["anyOf", "oneOf", "allOf"])
        expect(advertised).not.toHaveProperty(combinator);
      expect(advertised.description).toBe(
        "Provide a complete input group: before + after; before_scenario + after_scenario + [normalization].",
      );
      const ajv = validatorFor(target);
      const validate = ajv.compile(advertised);
      for (const input of [
        { before: "first", after: "second" },
        { before_scenario: 1, after_scenario: 2 },
        { before_scenario: 1, after_scenario: 2, normalization: true },
      ]) {
        expect(schema.safeParse(input).success).toBe(true);
        expect(validate(input)).toBe(true);
      }
      for (const input of [
        {},
        { before: "first" },
        { unexpected: true },
        { before_scenario: 1, after_scenario: "wrong" },
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
        expect(validate(input)).toBe(false);
      }
      // The vendor-safe advertisement uses group guidance instead of
      // dependentRequired; the canonical runtime parser keeps exact unions.
      expect(
        schema.safeParse({ before_scenario: 1, normalization: true }).success,
      ).toBe(false);
      expect(validate({ before_scenario: 1, normalization: true })).toBe(true);
      expect(
        schema.safeParse({ after_scenario: 2, normalization: true }).success,
      ).toBe(false);
      expect(validate({ after_scenario: 2, normalization: true })).toBe(true);
      // Cross-group exclusion is enforced only by the canonical runtime parser.
      const mixed = {
        before: "first",
        after: "second",
        before_scenario: 1,
        after_scenario: 2,
      };
      expect(validate(mixed)).toBe(true);
      expect(schema.safeParse(mixed).success).toBe(false);
    },
  );

  it("keeps a root branch whose reference siblings cannot be merged", () => {
    const branch = { $ref: "#/$defs/object", additionalProperties: false };
    const root = {
      $defs: {
        object: { type: "object", properties: { value: { type: "string" } } },
      },
      anyOf: [branch],
    };
    const presented = presentInputJsonSchema(root, (property) => property);
    expect(presented.anyOf).toEqual([branch]);
    const ajv = validatorFor();
    for (const sample of [{}, { value: "value" }, { other: 1 }, null])
      expect(ajv.compile(presented)(sample)).toBe(ajv.compile(root)(sample));
  });

  it("preserves specialized guidance across reference chains without following literal references", () => {
    const literal = { properties: { literal: {} }, $ref: "#/$defs/missing" };
    const presented = presentInputJsonSchema(
      {
        $defs: {
          "a~b": {
            type: "string",
            description: "Literal URL selected by the caller.",
          },
          alias: { $ref: "#/$defs/a~0b" },
        },
        type: "object",
        properties: {
          url: { $ref: "#/$defs/alias" },
          other: { $ref: "#/$defs/alias", description: "Explicit override." },
        },
        default: literal,
        const: literal,
        examples: [literal],
        enum: [literal],
      },
      (property) => `Parameter ${property}`,
    );
    expect(presented).toMatchObject({
      properties: {
        url: { description: "Literal URL selected by the caller." },
        other: { description: "Explicit override." },
      },
      default: literal,
      const: literal,
      examples: [literal],
      enum: [literal],
    });
  });
});

it("preserves canonical callers when Boolean literals and predicates widen", () => {
  const canonical = {
    type: "object",
    properties: {
      enabled: { type: "boolean", const: false },
      flag: { type: "boolean", not: { const: false } },
      choice: {
        if: { const: false },
        then: { type: "string" },
        else: { type: "boolean" },
      },
      values: {
        type: "array",
        not: { items: { type: "boolean", const: false } },
      },
    },
  };
  const advertised = advertise(canonical);
  const original = validatorFor().compile(canonical);
  const presented = validatorFor().compile(advertised);
  const valid = { enabled: false, flag: true, choice: true, values: [true] };
  expect(original(valid)).toBe(true);
  expect(presented(valid)).toBe(true);
  for (const change of [
    { enabled: true },
    { flag: false },
    { choice: "text" },
    { values: [false] },
  ]) {
    const input = { ...valid, ...change };
    expect(original(input), JSON.stringify(change)).toBe(false);
    expect(presented(input), JSON.stringify(change)).toBe(true);
  }
  expect(advertised.properties).toEqual({
    enabled: { type: "boolean" },
    flag: { type: "boolean" },
    choice: {},
    values: { type: "array", items: {} },
  });
});

describe("advertised client-compatible literals", () => {
  it.each([{ const: "" }, { enum: ["", "named"] }])(
    "widens unsupported empty-string literals without changing canonical validation: %j",
    (literal) => {
      const canonical = {
        type: "object",
        properties: {
          value: {
            type: "string",
            ...literal,
            default: "",
            description: "The literal value.",
          },
        },
      };
      const advertised = advertise(canonical);
      expect(validatorFor().compile(canonical)({ value: "" })).toBe(true);
      expect(validatorFor().compile(advertised)({ value: "" })).toBe(true);
      expect(advertised).toHaveProperty(["properties", "value"], {
        type: "string",
      });
    },
  );

  it("widens overlapping empty-string oneOf branches while preserving nonempty alternatives", () => {
    const canonical = {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "string", const: "" },
            { type: "string", minLength: 1 },
          ],
        },
      },
    };
    const advertised = advertise(canonical);
    const original = validatorFor().compile(canonical);
    const presented = validatorFor().compile(advertised);
    for (const value of ["", "named"]) {
      expect(original({ value })).toBe(true);
      expect(presented({ value })).toBe(true);
    }
    expect(advertised).toHaveProperty(["properties", "value", "anyOf"]);
    expect(advertised).not.toHaveProperty(["properties", "value", "oneOf"]);
  });
});

describe("advertised Boolean schema composition", () => {
  it("widens an affected oneOf to anyOf when branches could overlap", () => {
    const canonical = {
      type: "object",
      properties: {
        flag: {
          oneOf: [{ type: "boolean", const: false }, {}],
        },
      },
    };
    const advertised = advertise(canonical);
    const canonicalValidate = validatorFor().compile(canonical);
    const advertisedValidate = validatorFor().compile(advertised);
    expect(canonicalValidate({ flag: true })).toBe(true);
    expect(canonicalValidate({ flag: false })).toBe(false);
    expect(advertisedValidate({ flag: true })).toBe(true);
    // A union with an any-value branch accepts every value.
    expect(advertised).toHaveProperty(["properties", "flag"], {});
  });

  it("retains nested branch guidance when widening oneOf to anyOf", () => {
    const canonical = {
      type: "object",
      properties: {
        selection: {
          oneOf: [
            {
              type: "object",
              properties: {
                source: { type: "string" },
                mode: { type: "boolean", const: false },
              },
              required: ["source", "mode"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                target: { type: "string" },
                mode: { type: "boolean", const: true },
              },
              required: ["target", "mode"],
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const advertised = advertise(canonical);
    const canonicalValidate = validatorFor().compile(canonical);
    const advertisedValidate = validatorFor().compile(advertised);
    const example = { selection: { source: "capture.json", mode: false } };
    expect(canonicalValidate(example)).toBe(true);
    expect(advertisedValidate(example)).toBe(true);
    expect(advertised).toMatchObject({
      properties: {
        selection: {
          anyOf: [
            { properties: { source: { type: "string" } } },
            { properties: { target: { type: "string" } } },
          ],
        },
      },
    });
  });
});

it.each(drafts)(
  "describes references from their containing resource in %s",
  (dialect) => {
    const presented = presentInputJsonSchema(
      {
        $schema:
          dialect === "draft-07"
            ? "http://json-schema.org/draft-07/schema#"
            : "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.test/root.json",
        type: "object",
        definitions: { value: { type: "string", description: "Outer text." } },
        properties: {
          child: {
            $id: "child.json",
            type: "object",
            definitions: {
              value: { type: "number", description: "Nested number." },
            },
            properties: { value: { $ref: "#/definitions/value" } },
          },
        },
      },
      () => undefined,
    );
    expect(presented).toMatchObject({
      properties: {
        child: { properties: { value: { description: "Nested number." } } },
      },
    });
  },
);

it.each(drafts)(
  "keeps root union resource identities when lifting would change relative refs in %s",
  (dialect) => {
    const source = {
      $schema:
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/root.json",
      anyOf: ["first", "second"].map((kind) => ({
        $id: `https://example.test/${kind}/schema.json`,
        type: "object",
        properties: { kind: { const: kind }, value: { $ref: "child.json" } },
        required: ["kind", "value"],
        additionalProperties: false,
      })),
    };
    const presented = presentInputJsonSchema(source, () => undefined);
    const createAjv = () => {
      const ajv = validatorFor(dialect);
      ajv.addSchema({
        $id: "https://example.test/first/child.json",
        type: "string",
      });
      ajv.addSchema({
        $id: "https://example.test/second/child.json",
        type: "number",
      });
      return ajv;
    };
    const canonical = createAjv().compile(source);
    const advertised = createAjv().compile(presented);
    for (const kind of ["first", "second"])
      for (const value of [7, "seven", null])
        expect(advertised({ kind, value })).toBe(canonical({ kind, value }));
  },
);

it("does not lift properties that still refer to deleted root-union locations", () => {
  const source = {
    anyOf: [
      {
        type: "object",
        properties: { value: { $ref: "#/anyOf/1/properties/value" } },
        required: ["value"],
      },
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    ],
  };
  const presented = presentInputJsonSchema(source, () => undefined);
  const canonical = validatorFor().compile(source);
  const advertised = validatorFor().compile(presented);
  for (const value of [7, "seven", null])
    expect(advertised({ value })).toBe(canonical({ value }));
});

it.each(["$ref", "$dynamicRef"])(
  "preserves the root union used by recursive %s children",
  (keyword) => {
    const source = {
      anyOf: [
        {
          type: "object",
          properties: { end: { const: "done" } },
          required: ["end"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { next: { [keyword]: "#" } },
          required: ["next"],
          additionalProperties: false,
        },
      ],
    };
    const presented = presentInputJsonSchema(source, () => undefined);
    expect(presented.anyOf).toBeDefined();
    const canonical = validatorFor().compile(source);
    const advertised = validatorFor().compile(presented);
    for (const value of [
      { end: "done" },
      { next: { end: "done" } },
      { next: {} },
      { next: { end: "invalid" } },
    ])
      expect(advertised(value)).toBe(canonical(value));
  },
);

describe("root union default presentation", () => {
  it("preserves a required prototype-named field in a group-only object", () => {
    const canonical = {
      anyOf: [
        {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: { ["__proto__"]: { type: "string", default: "" } },
              required: ["__proto__"],
              additionalProperties: false,
            },
          },
          required: ["config"],
          additionalProperties: false,
        },
      ],
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);

    expect(advertised).not.toHaveProperty("anyOf");
    const config = (advertised.properties as Record<string, unknown>)["config"];
    // Client-facing JSON must carry the field as an own property.
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      type: "object",
      properties: { ["__proto__"]: { type: "string" } },
      required: ["__proto__"],
      additionalProperties: false,
    });
  });

  it.each(drafts)(
    "keeps shared defaults while omitting conflicting and group-only defaults in %s",
    (target) => {
      const schema = z.union([
        z.strictObject({
          left: z.string(),
          shared: z.boolean().default(false),
          only_left: z.string().default("left"),
          selection: z.string().default("left"),
        }),
        z.strictObject({
          right: z.string(),
          shared: z.boolean().default(false),
          selection: z.string().default("right"),
          normalization: z
            .strictObject({ rules: z.array(z.string()).default([]) })
            .default({ rules: [] }),
        }),
      ]);
      const advertised = presentInputJsonSchema(
        z.toJSONSchema(schema, { io: "input", target }),
        () => undefined,
      );
      expect(advertised).toHaveProperty(
        ["properties", "shared", "default"],
        false,
      );
      expect(advertised).toHaveProperty(["properties", "selection"], {
        type: "string",
      });
      for (const path of [
        ["only_left", "default"],
        ["normalization", "default"],
        ["normalization", "properties", "rules", "default"],
      ])
        expect(advertised).not.toHaveProperty(["properties", ...path]);

      const validate = validatorFor(target, { useDefaults: true }).compile(
        advertised,
      );
      for (const selected of [{ left: "before" }, { right: "after" }]) {
        const input = { ...selected };
        expect(validate(input)).toBe(true);
        expect(input).toEqual({ ...selected, shared: false });
        expect(schema.safeParse(input).success).toBe(true);
      }
    },
  );

  it.each(drafts)(
    "keeps a nested default targeted by a reference in its resource in %s",
    (target) => {
      const canonical = {
        $schema:
          target === "draft-07"
            ? "http://json-schema.org/draft-07/schema#"
            : "https://json-schema.org/draft/2020-12/schema",
        anyOf: [
          {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              normalization: {
                $id: "https://example.test/normalization",
                type: "object",
                properties: {
                  rules: { type: "object" },
                  alias: { $ref: "#/default/rules" },
                },
                default: { rules: { type: "string" } },
              },
            },
            required: ["normalization"],
            additionalProperties: false,
          },
        ],
      };
      const advertised = presentInputJsonSchema(canonical, () => undefined);
      expect(advertised).not.toHaveProperty("anyOf");
      const validate = validatorFor(target).compile(advertised);
      expect(validate({ text: "raw" })).toBe(true);
      expect(validate({ normalization: { alias: "rule" } })).toBe(true);
      expect(validate({ normalization: { alias: 7 } })).toBe(false);
    },
  );
});

describe("advertised empty-string literal edge cases", () => {
  it("drops an empty-string literal under contentSchema", () => {
    const canonical = {
      type: "object",
      properties: {
        value: { type: "string", contentSchema: { const: "" } },
      },
    };
    const advertised = advertise(canonical);
    expect(advertised.properties).toEqual({ value: { type: "string" } });
  });

  it("removes the recorded trace seed's empty-string literals from the advertisement", () => {
    const canonical = z.toJSONSchema(
      z.strictObject({ seed: applicationFeatureSeedSchema }),
      { io: "input", target: "draft-2020-12" },
    );
    const advertised = advertise(canonical);
    expect(JSON.stringify(advertised)).not.toContain('"const":""');
    const canonicalValidate = validatorFor().compile(canonical);
    const advertisedValidate = validatorFor().compile(advertised);
    const emptyRoute = { kind: "route", value: "", match: "exact" };
    expect(canonicalValidate({ seed: emptyRoute })).toBe(true);
    expect(advertisedValidate({ seed: emptyRoute })).toBe(true);
    expect(
      canonicalValidate({
        seed: { kind: "route", value: "", match: "contains" },
      }),
    ).toBe(false);
  });
});
