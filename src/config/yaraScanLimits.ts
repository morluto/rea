import { launchAnalysisSetting } from "./analysisSettings.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  YaraScanSettings,
  YaraSettingValue,
} from "../domain/yara/yaraMatches.js";

const SETTINGS = {
  max_matches: "yara.max_matches",
  max_output_bytes: "yara.max_output_bytes",
  command_timeout_ms: "yara.command_timeout_ms",
} as const satisfies Record<keyof YaraScanSettings, string>;

/**
 * Resolve each control: the caller's argument, then the accepted runtime
 * override, then the launch seed, then the default. An invalid seed is
 * refused rather than replaced by the default.
 */
export const resolveYaraScanSettings = (
  request: Partial<Record<keyof YaraScanSettings, number>>,
  environment: Readonly<Record<string, string | undefined>>,
  settings: AnalysisSettingsReader | undefined,
): Result<YaraScanSettings, ConfigurationError> => {
  const overrides = settings?.().overrides;
  const resolved: Partial<Record<keyof YaraScanSettings, YaraSettingValue>> =
    {};
  for (const parameter of Object.keys(SETTINGS) as (keyof YaraScanSettings)[]) {
    const setting = SETTINGS[parameter];
    const requested = request[parameter];
    const override = overrides?.[setting];
    if (requested !== undefined) {
      resolved[parameter] = { value: requested, source: "request" };
      continue;
    }
    if (override !== undefined) {
      resolved[parameter] = { value: override, source: "runtime" };
      continue;
    }
    const launch = launchAnalysisSetting(setting, environment);
    if (!launch.ok) return err(launch.error);
    // Every yara setting has a numeric default, so the launch value is a number.
    resolved[parameter] = {
      value: launch.value.value as number,
      source: launch.value.source,
    };
  }
  return ok(resolved as YaraScanSettings);
};
