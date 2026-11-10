import { z } from "incur";
import { safeParseJson } from "../domain/safeJson.js";

/** Incur passes object flags as text; validate the selected producer's exact policy. */
export const producerLimitsOption = <Schema extends z.ZodType>(
  schema: Schema,
  flagName = "producer-limits",
) =>
  z
    .string()
    .transform((text, context) => {
      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        context.addIssue({
          code: "custom",
          message: `${flagName} must be a JSON object`,
        });
        return z.NEVER;
      }
      return parsed.value;
    })
    .pipe(schema)
    .optional()
    .describe(
      "JSON producer budget overrides. Keys and units follow this operation's producer_limits contract; changes apply on this call without restart and preserve tighter inherited OS limits.",
    );
