import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect, it } from "vitest";
import { z } from "zod";

import { toolContract } from "./toolContracts.js";
import { toolOutputSchemaWithMetadata } from "./toolSchemaMetadata.js";

it("keeps dialect-specific validators distinct after JSON schema serialization", () => {
  const contract = {
    ...toolContract("binary_session"),
    outputSchema: z.strictObject({ value: z.number().int().min(1).max(8) }),
  };
  const output = toolOutputSchemaWithMetadata(contract);
  const provider = new AjvJsonSchemaValidator();
  for (const target of ["draft-2020-12", "draft-07"] as const) {
    const projected = output["~standard"].jsonSchema.output({ target });
    const parsed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(JSON.stringify(projected)));
    const validate = provider.getValidator(parsed);
    expect(validate({ value: 8 }).valid).toBe(true);
    expect(validate({ value: 9 }).valid).toBe(false);
    expect(validate({ value: 1.5 }).valid).toBe(false);
  }
});

it("preserves explicit schema identity and relative reference resolution", () => {
  const value = z.string();
  const canonical = z.strictObject({ value });
  const contract = {
    ...toolContract("binary_session"),
    outputSchema: canonical,
  };
  const projected = toolOutputSchemaWithMetadata(contract)[
    "~standard"
  ].jsonSchema.output({
    target: "draft-2020-12",
    libraryOptions: {
      override: (context: {
        readonly zodSchema: unknown;
        readonly jsonSchema: Record<string, unknown>;
      }) => {
        if (context.zodSchema !== value) return;
        delete context.jsonSchema.type;
        context.jsonSchema.$ref = "child.json";
      },
    },
  });
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema({ $id: "child.json", type: "string", minLength: 3 });
  const validate = ajv.compile(projected);
  expect(validate({ value: "abc" })).toBe(true);
  expect(validate({ value: "ab" })).toBe(false);

  const identified = toolOutputSchemaWithMetadata({
    ...contract,
    outputSchema: canonical.meta({ $id: "https://example.test/result" }),
  })["~standard"].jsonSchema.output({ target: "draft-2020-12" });
  expect(identified.$id).toBe("https://example.test/result");
  const explicit = ajv.compile(identified);
  expect(explicit({ value: "abc" })).toBe(true);
  expect(explicit({ value: 1 })).toBe(false);
});

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
  },
);

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
  },
);
