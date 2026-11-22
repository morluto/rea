import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  presentCompleteObservation,
  presentRootDiscriminator,
  schemaAnnotations,
} from "./schemaAnnotations.js";

const alternatives = () =>
  [
    z.strictObject({ mode: z.literal("a"), a: z.string() }),
    z.strictObject({ mode: z.literal("b").optional(), b: z.string() }),
  ] as const;

type DiscriminatedSchema = z.ZodUnion<ReturnType<typeof alternatives>>;
expectTypeOf<
  Parameters<typeof presentRootDiscriminator<DiscriminatedSchema>>[1]
>().toEqualTypeOf<"mode">();

it("keeps a root discriminator out of the canonical JSON Schema", () => {
  const schema = presentRootDiscriminator(z.union(alternatives()), "mode");
  expect(schemaAnnotations(schema)).toEqual({ rootDiscriminator: "mode" });
  expect(z.toJSONSchema(schema)).toEqual(
    z.toJSONSchema(z.union(alternatives())),
  );
});

it("follows clones of the declaring schema, not other schemas", () => {
  const schema = presentRootDiscriminator(z.union(alternatives()), "mode");
  expect(schemaAnnotations(schema.describe("described"))).toEqual({
    rootDiscriminator: "mode",
  });
  expect(schemaAnnotations(schema.optional())).toBeUndefined();
  expect(schemaAnnotations(z.union(alternatives()))).toBeUndefined();
});

it("annotates a copy as a complete observation, leaving the source canonical", () => {
  const source = z.object({ id: z.string() }).describe("Producer result.");
  const operand = presentCompleteObservation(source);
  expect(schemaAnnotations(operand)).toEqual({ completeObservation: true });
  expect(schemaAnnotations(source)).toBeUndefined();
  expect(z.toJSONSchema(operand)).toEqual(z.toJSONSchema(source));
  expect(operand.parse({ id: "x" })).toEqual({ id: "x" });
  expect(() => operand.parse({})).toThrow();
});
