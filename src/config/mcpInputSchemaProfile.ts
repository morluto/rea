import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

const profileConstraint =
  'REA_MCP_INPUT_SCHEMA_PROFILE accepts only "compact", the default. The "full" input profile was removed: remove the setting from the client registration, or set it to "compact". Canonical server-side validation still checks every call. The removed full profile can still hit provider or gateway limits such as Moonshot size caps (#1484) or WorkBuddy/CodeBuddy HTTP 400 code 11133 (#2999).';

/**
 * Only `compact` remains so registrations that spell the default keep
 * starting; any other value, including the removed `full`, fails closed.
 */
export const mcpInputSchemaProfileSchema = z.enum(["compact"], {
  error: profileConstraint,
});

export type McpInputSchemaProfile = z.infer<typeof mcpInputSchemaProfileSchema>;

/** Parse the advertised input schema presentation selection. */
export const parseMcpInputSchemaProfile = (
  value: string | undefined,
): Result<McpInputSchemaProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpInputSchemaProfileSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(profileConstraint, {
          settings: [
            {
              setting: "REA_MCP_INPUT_SCHEMA_PROFILE",
              constraint: profileConstraint,
            },
          ],
        }),
      );
};
