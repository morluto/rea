import { z } from "zod";
import { fixedTupleSchema } from "../fixedTupleSchema.js";
const byte = z.number().int().min(0).max(255);
const sentinel = z.enum(["profile", "disabled"]);
/** Choices are explicit; neither theme nor alpha is inferred from image bytes. */
export const rasterColorPolicyInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("diagnostic-indices") }),
  z.strictObject({
    kind: z.literal("rgba-palette"),
    entries: z
      .array(fixedTupleSchema([byte, byte, byte, byte]))
      .min(1)
      .max(256),
    index_space: z.enum(["selector", "lookup-low-byte"]),
    sentinel,
  }),
  z.strictObject({
    kind: z.literal("record12-lut-registry"),
    theme_slot: z.number().int().min(0).max(255),
    precision: z.enum(["byte8", "expand-high6"]),
    alpha: z.enum(["palette", "opaque"]),
    sentinel,
    rgb565_color_key: z.number().int().min(0).max(65535).nullable(),
  }),
]);
export const rasterRegistrySelectionInputSchema = z.strictObject({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pointer_bias: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
});
