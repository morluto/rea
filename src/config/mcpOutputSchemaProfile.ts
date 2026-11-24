import { z } from "zod";

import {
  MCP_OUTPUT_SCHEMA_PROFILES,
  type McpOutputSchemaProfile,
} from "../contracts/mcpSchemaPresentation.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import type { Result } from "../domain/result.js";
import { parseOptionalMcpSetting } from "./optionalMcpSetting.js";

const profileConstraint =
  'REA_MCP_OUTPUT_SCHEMA_PROFILE must be "off" (default) or "compact". The off profile omits output schemas; compact advertises every output schema within a 4,096-byte budget. The "full" output profile was removed: remove the setting or select "compact". Both keep canonical server-side validation and complete structured content.';

/** Select whether tools/list carries bounded output contracts. */
export const mcpOutputSchemaProfileSchema = z.enum(MCP_OUTPUT_SCHEMA_PROFILES, {
  error: profileConstraint,
});

/** Parse the output schema advertisement selection at server composition. */
export const parseMcpOutputSchemaProfile = (
  value: string | undefined,
): Result<McpOutputSchemaProfile | undefined, ConfigurationError> =>
  parseOptionalMcpSetting(
    value,
    mcpOutputSchemaProfileSchema,
    "REA_MCP_OUTPUT_SCHEMA_PROFILE",
    profileConstraint,
  );
