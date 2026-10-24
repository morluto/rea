import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Select whether tools/list carries the large output contracts. */
export const mcpOutputSchemaProfileSchema = z.enum(["full", "off"]);

export type McpOutputSchemaProfile = z.infer<
  typeof mcpOutputSchemaProfileSchema
>;

const profileConstraint =
  'REA_MCP_OUTPUT_SCHEMA_PROFILE must be "off" (default) or "full". The off profile omits output schemas from tools/list while REA validates every successful result against its canonical tool contract and returns complete structured content; full advertises the complete output contracts to clients.';

/** Resolve the selected advertisement at the configuration boundary. */
export const resolveMcpOutputSchemaProfile = (
  profile: McpOutputSchemaProfile | undefined,
): McpOutputSchemaProfile => profile ?? "off";

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
