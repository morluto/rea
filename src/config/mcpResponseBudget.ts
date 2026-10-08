import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

// This override supports clients with larger frames. Keep the configuration
// parser independent of the SDK's eager server imports; conformance verifies
// this floor against the pinned SDK's actual default receive-buffer size.
const MINIMUM_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Optional stdio response budget, including room for the protocol envelope. */
export const mcpResponseBudgetSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .pipe(z.number().int().safe().min(MINIMUM_RESPONSE_BYTES));

/** Parse only the MCP-specific budget without loading unrelated provider settings. */
export const parseMcpResponseBudget = (
  value: string | undefined,
): Result<number | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpResponseBudgetSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(
          `REA_MCP_MAX_RESPONSE_BYTES must be a decimal safe integer at least ${String(MINIMUM_RESPONSE_BYTES)} bytes, the default stdio receive-buffer size.`,
        ),
      );
};
