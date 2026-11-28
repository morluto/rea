import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";
import { YARA_SETTING_BOUNDS } from "../domain/yara/yaraMatches.js";

const seed = (name: keyof typeof YARA_SETTING_BOUNDS) =>
  positiveDecimalIntegerSchema(
    YARA_SETTING_BOUNDS[name].minimum,
    YARA_SETTING_BOUNDS[name].maximum,
    "must be a positive decimal integer",
  );

/** Launch seeds of the yara settings, parsed by the shared configuration owner. */
export const YARA_SETTING_SEEDS = {
  REA_YARA_COMMAND_TIMEOUT_MS: seed("command_timeout_ms"),
  REA_YARA_MAX_OUTPUT_BYTES: seed("max_output_bytes"),
  REA_YARA_MAX_MATCHES: seed("max_matches"),
} as const;
