import { z } from "zod";
import { functionDossierSchema } from "../native/functionDossier.js";
import { MAXIMUM_GHIDRA_SIGNATURE_MAX_UTF16 } from "../analysisResourceLimits.js";

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
      .max(MAXIMUM_GHIDRA_SIGNATURE_MAX_UTF16)
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
      calling_convention: z
        .string()
        .min(1)
        .describe(
          "Convention Ghidra assigns parameter storage with; unknown when the function has none recorded",
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
