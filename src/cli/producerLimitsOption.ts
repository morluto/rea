import { z } from "incur";
import { safeParseJson } from "../domain/safeJson.js";

/** CLI help for a producer's `producer_limits` JSON text. */
export const PRODUCER_LIMITS_HELP =
  "JSON producer budget overrides. Keys and units follow this operation's producer_limits contract; changes apply on this call without restart and preserve tighter inherited OS limits.";

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
    .describe(PRODUCER_LIMITS_HELP);
