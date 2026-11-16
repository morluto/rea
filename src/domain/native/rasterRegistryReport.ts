import { z } from "zod";
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ offset, length: offset });
const mapping = z.strictObject({
  ranges: z.array(range).max(256),
  complete: z.boolean(),
});
/** Published coordinates are logical; encoded pointer bias is adjusted once by logicalBase. */
export const rasterRegistryFamilyReportSchema = z.strictObject({
  family: z.literal("record12-lut-registry"),
  provenance: z.literal("profile-declared"),
  status: z.enum(["unsupported", "unique", "ambiguous"]),
  registries: z
    .array(
      z.strictObject({
        range,
        pointerBias: z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
        rows: z
          .array(
            z.strictObject({
              range,
              tableRange: range,
              recordCount: offset,
              countSource: z.enum(["static-u16", "enclosed-dynamic"]),
              countRange: range.nullable(),
              dynamicOwnerRange: range.nullable(),
            }),
          )
          .max(128),
        bindings: z
          .array(
            z.strictObject({
              descriptorOffset: offset,
              format: offset,
              width: offset,
              height: offset,
              layout: z.enum([
                "indexed1",
                "indexed2",
                "indexed4",
                "indexed8",
                "rgb565le",
              ]),
              bitsPerPixel: offset,
              offsetUnit: offset,
              stride: offset,
              payloadRange: range,
              lookupRange: range.nullable(),
              payloadSourceMapping: mapping,
              lookupSourceMapping: mapping.nullable(),
              rowOrder: z.literal("bottom-up"),
              bitOrder: z.literal("msb-first"),
              provenance: z.literal("profile-declared"),
            }),
          )
          .max(4096),
        bindingStatus: z.enum(["unique", "conflicting"]),
        palettePointerRange: range.nullable(),
        palettes: z
          .array(
            z.strictObject({ slot: offset, range, sourceMapping: mapping }),
          )
          .max(4),
        availableBindings: offset,
        bindingsTruncated: z.boolean(),
      }),
    )
    .max(128),
  coverage: z.strictObject({
    complete: z.boolean(),
    work: offset,
    maxWork: offset,
    reason: z.enum(["work-limit", "row-limit", "binding-limit"]).nullable(),
    nextOffset: offset.nullable(),
    discoveryComplete: z.boolean(),
  }),
  limitations: z.array(z.string()),
});
