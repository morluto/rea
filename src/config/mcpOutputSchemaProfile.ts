import { z } from "zod";

import {
  MCP_OUTPUT_SCHEMA_PROFILES,
  type McpOutputSchemaProfile,
} from "../contracts/mcpSchemaPresentation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

const profileConstraint =
  'REA_MCP_OUTPUT_SCHEMA_PROFILE must be "off" (default) or "compact". The off profile omits output schemas; compact advertises every output schema within a 4,096-byte budget. The "full" output profile was removed: remove the setting or select "compact". Both keep canonical server-side validation and complete structured content.';

/** Select whether tools/list carries bounded output contracts. */
export const mcpOutputSchemaProfileSchema = z.enum(MCP_OUTPUT_SCHEMA_PROFILES, {
  error: profileConstraint,
});

/** Parse the output schema advertisement selection at server composition. */
export const parseMcpOutputSchemaProfile = (
  value: string | undefined,
): Result<McpOutputSchemaProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpOutputSchemaProfileSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(profileConstraint, {
          settings: [
            {
              setting: "REA_MCP_OUTPUT_SCHEMA_PROFILE",
              constraint: profileConstraint,
            },
          ],
        }),
      );
};
