import { z } from "zod";

/**
 * Derived from the provider's listing, not reported by the decompiler: the
 * listing basic block that contains a dropped block's reported start. It may
 * begin before that start and need not cover the whole removed region.
 */
const listingBlockSchema = z.strictObject({
  provenance: z.string().min(1),
  relation: z.literal("contains-reported-start"),
  start: z.string().min(1),
  end: z.string().min(1).describe("Exclusive end of the listing block."),
  assembly: z
    .array(z.string())
    .describe("Every listing instruction in [start, end)."),
});

/** Provider-reported diagnostics; silence does not prove complete decompilation. */
export const decompilerCompletenessSchema = z
  .strictObject({
    status: z.enum(["warnings", "no-warnings-reported", "unavailable"]),
    provenance: z.string().min(1),
    warning_count: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    diagnostic: z.string().min(1).nullable(),
    dropped_blocks: z.array(
      z.strictObject({
        start: z.string().min(1).nullable(),
        end: z
          .null()
          .describe(
            "The decompiler reports only where a removed block starts; its end is unknown.",
          ),
        address_space: z.string().min(1),
        reported_offset: z.string().min(1).nullable(),
        reason: z.literal("unreachable"),
        warning_index: z.number().int().nonnegative(),
        listing_block: listingBlockSchema.exactOptional(),
      }),
    ),
    disassembly_available: z.boolean(),
  })
  .superRefine((value, context) => {
    const warned = value.warnings.length > 0 || value.diagnostic !== null;
    if (
      value.warning_count !== value.warnings.length ||
      (value.status === "warnings") !== warned ||
      value.dropped_blocks.some(
        (block) =>
          block.warning_index >= value.warnings.length ||
          (block.start === null && block.listing_block !== undefined),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Decompiler diagnostic counts or status are inconsistent",
      });
  })
  .describe(
    "Decompiler warnings and diagnostics as the provider reported them. no-warnings-reported does not establish complete control-flow recovery.",
  );
