import { z } from "zod";
import { jsonValueSchema } from "../jsonValue.js";

const procedure = z
  .string()
  .min(1)
  .describe("Function symbol name or hexadecimal entry address");
const variable = z
  .string()
  .min(1)
  .describe("Current variable name as rendered in the provider's pseudocode");
const cType = z.string().min(1).describe("C type text, e.g. `unsigned int *`");
const batchOptions = {
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "Resolve and validate every item without applying it; may still decompile a function to resolve a variable",
    ),
};

export const renameNativeVariablesInputSchema = z.strictObject({
  items: z
    .array(z.strictObject({ procedure, variable, new_name: z.string().min(1) }))
    .min(1),
  allow_overwrite: z
    .boolean()
    .default(false)
    .describe("Permit a name already bound to another variable"),
  ...batchOptions,
});

export const setNativeVariableTypesInputSchema = z.strictObject({
  items: z
    .array(
      z.union([
        z.strictObject({ procedure, variable, type: cType }),
        z.strictObject({
          address: z
            .string()
            .min(1)
            .describe("Hexadecimal address of a global variable"),
          type: cType,
        }),
      ]),
    )
    .min(1),
  redecompile: z
    .boolean()
    .default(false)
    .describe(
      "Fully re-decompile each affected function instead of re-inferring types through cached constraints",
    ),
  ...batchOptions,
});

export const setNativeFunctionPrototypesInputSchema = z.strictObject({
  items: z
    .array(
      z.union([
        z.strictObject({
          procedure,
          signature: z
            .string()
            .min(1)
            .describe(
              "Complete C signature, e.g. `int parse(char *buf, int len)`; the name inside it is ignored",
            ),
        }),
        z.strictObject({ procedure, return_type: cType }),
      ]),
    )
    .min(1),
  ...batchOptions,
});

export const setNativeDecompilationFlavorInputSchema = z.strictObject({
  flavor: z
    .string()
    .min(1)
    .describe("Provider flavor name, such as pseudocode, rust, or go"),
});

/** One item's outcome; failed items report their reason instead of aborting the batch. */
export const nativeEditItemResultSchema = z.strictObject({
  index: z.number().int().min(0),
  status: z.enum(["ok", "unchanged", "error", "skipped"]),
  procedure: z
    .strictObject({ address: z.string().min(1), name: z.string().min(1) })
    .nullable(),
  target: z.string().nullable(),
  old: z.string().nullable(),
  new: z.string().nullable(),
  error: z.string().nullable(),
  detail: z.record(z.string(), jsonValueSchema),
});

/** Per-item readback of one batch of session-scoped decompilation edits. */
export const nativeDecompilationEditsSchema = z
  .strictObject({
    dry_run: z.boolean(),
    total: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    results: z.array(nativeEditItemResultSchema),
    functions_affected: z.array(z.string().min(1)),
    effects: z.strictObject({
      scope: z.literal("session-analysis-database"),
      source_bytes_modified: z.literal(false),
      persists_after_close: z.literal(false),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.results.length !== value.total ||
      value.succeeded + value.unchanged + value.failed + value.skipped !==
        value.total
    )
      context.addIssue({
        code: "custom",
        message: "Edit batch counts disagree with its per-item results",
      });
  });
export type NativeDecompilationEdits = z.infer<
  typeof nativeDecompilationEditsSchema
>;

/** Session-wide decompilation flavor with the provider's language hint. */
export const nativeDecompilationFlavorSchema = z.strictObject({
  flavor: z.string().min(1),
  previous_flavor: z.string().min(1).nullable(),
  available_flavors: z.array(z.string().min(1)).min(1),
  detected_language: z.string().min(1).nullable(),
  detection_confidence: z.string().min(1).nullable(),
});
