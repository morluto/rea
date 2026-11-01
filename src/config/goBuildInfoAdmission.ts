import { z } from "zod";
import {
  DEFAULT_GO_MAX_BUILD_INFO_BYTES,
  MAXIMUM_GO_MAX_BUILD_INFO_BYTES,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const GO_BUILD_INFO_ADMISSION_SETTING = "REA_GO_MAX_BUILD_INFO_BYTES";

/** One accepted operation's aggregate embedded-string admission. */
export interface GoBuildInfoAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_GO_BUILD_INFO_ADMISSION: GoBuildInfoAdmission = {
  maximumBytes: DEFAULT_GO_MAX_BUILD_INFO_BYTES,
  source: "default",
};

const constraint = `${GO_BUILD_INFO_ADMISSION_SETTING} must be a positive decimal integer of at most ${String(MAXIMUM_GO_MAX_BUILD_INFO_BYTES)} bytes (16 MiB); the default is ${String(DEFAULT_GO_MAX_BUILD_INFO_BYTES)} bytes (1 MiB).`;
const launchSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAXIMUM_GO_MAX_BUILD_INFO_BYTES));

export const parseGoBuildInfoAdmission = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<GoBuildInfoAdmission, ConfigurationError> => {
  const value = environment[GO_BUILD_INFO_ADMISSION_SETTING];
  if (value === undefined) return ok(DEFAULT_GO_BUILD_INFO_ADMISSION);
  const parsed = launchSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(constraint, {
          settings: [{ setting: GO_BUILD_INFO_ADMISSION_SETTING, constraint }],
          remediationAction: `On MCP, set go.max_build_info_bytes using update_analysis_settings to a positive integer of at most ${String(MAXIMUM_GO_MAX_BUILD_INFO_BYTES)} bytes, then retry inspect_go_binary. For CLI or future processes, correct ${GO_BUILD_INFO_ADMISSION_SETTING} in the launch environment.`,
        }),
      );
};

export const goBuildInfoAdmissionRecovery = (maximumBytes: number): string =>
  `The Go build-info string allowance is ${String(maximumBytes)} aggregate bytes. On MCP, call update_analysis_settings with setting go.max_build_info_bytes, action set, and a value in bytes up to ${String(MAXIMUM_GO_MAX_BUILD_INFO_BYTES)} (16 MiB), then retry inspect_go_binary. It applies to the next operation without restarting REA. For CLI or future processes, set ${GO_BUILD_INFO_ADMISSION_SETTING} in the launch environment. The default is ${String(DEFAULT_GO_MAX_BUILD_INFO_BYTES)} bytes (1 MiB). The separate input, header-search, structural and complete-report allowances still apply; raising this allowance does not raise them or bound total process memory. At the ceiling, select an artifact within the allowance; repeating the unchanged request will fail again.`;
