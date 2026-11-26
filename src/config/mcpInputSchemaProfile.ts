import { z } from "zod";

import { optionalSettingParser } from "./optionalSetting.js";

const profileConstraint =
  'REA_MCP_INPUT_SCHEMA_PROFILE accepts only "compact", the default. The "full" input profile was removed: remove the setting from the client registration, or set it to "compact". Canonical server-side validation still checks every call.';

/**
 * Only `compact` remains so registrations that spell the default keep
 * starting; any other value, including the removed `full`, fails closed.
 */
export const mcpInputSchemaProfileSchema = z.enum(["compact"], {
  error: profileConstraint,
});

/** Parse the advertised input schema presentation selection. */
export const parseMcpInputSchemaProfile = optionalSettingParser(
  "REA_MCP_INPUT_SCHEMA_PROFILE",
  mcpInputSchemaProfileSchema,
  profileConstraint,
);
