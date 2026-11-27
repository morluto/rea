import { z } from "zod";
import { functionDossierSchema } from "../native/functionDossier.js";

/**
 * Ghidra's C parser cannot be cancelled. A chain of pointer or array
 * declarators takes about one second to parse at this length and grows
 * cubically beyond it; the Java bridge enforces the same ceiling.
 */
export const MAX_NATIVE_FUNCTION_SIGNATURE_LENGTH = 4096;

/** One explicit function's analyst-authored metadata changes. */
export const nativeFunctionAnnotationsInputSchema = z
  .strictObject({
    procedure: z
      .string()
      .min(1)
      .describe(
        "Function name or address selecting a function; edits apply at its entry.",
      ),
    name: z.string().min(1).optional(),
    comment: z
      .string()
      .optional()
      .describe("Regular entry comment; empty text clears it"),
    inline_comment: z
      .string()
      .optional()
      .describe("Inline entry comment; empty text clears it"),
    signature: z
      .string()
      .min(1)
      .max(MAX_NATIVE_FUNCTION_SIGNATURE_LENGTH)
      .optional()
      .describe(
        "C prototype using types the database already holds, e.g. `double f(struct session *s, unsigned mask)`. Its function name is a placeholder; rename with name. Add missing types with define_native_data_types first.",
      ),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.comment !== undefined ||
      value.inline_comment !== undefined ||
      value.signature !== undefined,
    "Supply at least one annotation change",
  );

/** Readback and refreshed analysis after one atomic metadata edit. */
export const nativeFunctionAnnotationsSchema = z
  .strictObject({
    annotations: z.strictObject({
      address: z.string().min(1),
      name: z.string().min(1),
      comment: z.string().nullable(),
      inline_comment: z.string().nullable(),
      signature: z
        .string()
        .min(1)
        .describe(
          "Formal prototype after the edit, in the form the signature field accepts",
        ),
      signature_source: z
        .string()
        .min(1)
        .describe(
          "Ghidra source of the prototype: user_defined is caller-authored; default, analysis and imported are not",
        ),
    }),
    dossier: functionDossierSchema,
    effects: z.strictObject({
      scope: z.literal("session-analysis-database"),
      source_bytes_modified: z.literal(false),
      persists_after_close: z.literal(false),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.annotations.address !== value.dossier.procedure.address ||
      value.annotations.name !== value.dossier.procedure.name
    )
      context.addIssue({
        code: "custom",
        message:
          "Annotation readback disagrees with refreshed function identity",
      });
  });
