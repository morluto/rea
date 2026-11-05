import { FIRMWARE_TOOL_REQUIREMENTS } from "../contracts/firmware/firmwareToolRequirements.js";

/** Catalog identity for the verified Binwalk release. Evidence replaces version with the observed banner. */
export const BINWALK_PROVIDER_IDENTITY = {
  id: "binwalk",
  name: FIRMWARE_TOOL_REQUIREMENTS.binwalk.name,
  version: FIRMWARE_TOOL_REQUIREMENTS.binwalk.version,
} as const;

/** Catalog identity for explicit firmware extraction. */
export const UNBLOB_PROVIDER_IDENTITY = {
  id: "unblob",
  name: FIRMWARE_TOOL_REQUIREMENTS.unblob.name,
  version: FIRMWARE_TOOL_REQUIREMENTS.unblob.version,
} as const;
