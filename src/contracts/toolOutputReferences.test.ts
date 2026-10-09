import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

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
