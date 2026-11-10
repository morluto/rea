import { z } from "zod";

/** Exact member selector shared with follow-up APK method inspection. */
export const androidMethodSelectorSchema = z.strictObject({
  class_name: z.string().min(1),
  method_name: z.string().min(1),
  overload_index: z.int().nonnegative(),
});

/** One using node of a traced class or method, as the provider reported it. */
export const androidReferenceSchema = z.strictObject({
  kind: z.string(),
  name: z.string(),
  reported_full_name: z.string(),
  containing_class: z.string(),
  top_class: z.string(),
  source_line: z.null(),
  dex_offset: z.null(),
  /** An explicit follow-up selector accepted by inspect_android_method. */
  source_selector: androidMethodSelectorSchema.exactOptional(),
  /** false means transport-bounded instruction evidence; null is unknown. */
  direct_invokes_exhaustive: z.boolean().nullable(),
  /** Raw direct invoke instructions inside this using node, when available. */
  direct_invokes: z
    .array(
      z.strictObject({
        dex_entry: z.string().min(1),
        source_raw_method_id: z.string().min(1),
        dex_code_unit_offset: z.int().nonnegative(),
        dex_method_index: z.int().nonnegative(),
        opcode: z.string().regex(/^INVOKE_/u),
      }),
    )
    .nullable(),
});
