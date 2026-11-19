import { z } from "zod";
import {
  DEFAULT_ZSTD_MAX_FRAMES,
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../analysisResourceLimits.js";
import { currentAnalysisSettingOverride } from "../analysisOperationSnapshot.js";
import { ConfigurationError } from "../configurationErrors.js";
import { ParseFailureError } from "../parseFailure.js";

/** Launch seed for the shared Zstandard frame allowance. */
export const ZSTD_MAX_FRAMES_ENVIRONMENT = "REA_ZSTD_MAX_FRAMES";

/** Registered analysis setting that owns this allowance. */
export const ZSTD_MAX_FRAMES_SETTING = "zstd.max_frames" as const;

export type ZstandardFrameSource = "default" | "setting" | "runtime";

/** The frame allowance in force for one decode, and where it came from. */
export interface ZstandardFrameAllowance {
  readonly maxFrames: number;
  readonly source: ZstandardFrameSource;
}

const constraint = `${ZSTD_MAX_FRAMES_ENVIRONMENT} must be a decimal integer from ${String(MINIMUM_ZSTD_MAX_FRAMES)} to ${String(MAXIMUM_ZSTD_MAX_FRAMES)} frames; the default is ${String(DEFAULT_ZSTD_MAX_FRAMES)}.`;

const decimalInteger = /^[1-9]\d*$/u;

/** Environment seed for `zstd.max_frames`, shared with launch admission. */
export const zstandardMaxFramesSchema = z
  .string()
  .regex(decimalInteger, { error: constraint })
  .refine(
    (value) => {
      if (!decimalInteger.test(value)) return true;
      const parsed = BigInt(value);
      return (
        parsed >= BigInt(MINIMUM_ZSTD_MAX_FRAMES) &&
        parsed <= BigInt(MAXIMUM_ZSTD_MAX_FRAMES)
      );
    },
    { error: constraint },
  )
  .transform(Number);

const invalidSeed = (): ConfigurationError =>
  new ConfigurationError(constraint, {
    remediationAction: `On a running MCP session, call update_analysis_settings for ${ZSTD_MAX_FRAMES_SETTING}, then retry. For CLI or future REA processes, correct ${ZSTD_MAX_FRAMES_ENVIRONMENT} in the launch environment.`,
    settings: [
      {
        setting: ZSTD_MAX_FRAMES_ENVIRONMENT,
        constraint,
        update_mode: "runtime",
        pending_restart: false,
      },
    ],
  });

/**
 * Resolve the allowance for one decode. A runtime override wins, then the
 * launch seed, then the default. An invalid seed is refused; it is not
 * replaced by the default.
 */
export const resolveZstandardFrameAllowance = (
  environment: Readonly<Record<string, string | undefined>>,
  override: number | undefined = currentAnalysisSettingOverride(
    ZSTD_MAX_FRAMES_SETTING,
  ),
): ZstandardFrameAllowance => {
  if (override !== undefined) return { maxFrames: override, source: "runtime" };
  const raw = environment[ZSTD_MAX_FRAMES_ENVIRONMENT];
  if (raw === undefined)
    return { maxFrames: DEFAULT_ZSTD_MAX_FRAMES, source: "default" };
  const parsed = zstandardMaxFramesSchema.safeParse(raw);
  if (!parsed.success) throw invalidSeed();
  return { maxFrames: parsed.data, source: "setting" };
};

/** Allowance for the operation on this stack, or the process launch environment. */
export const currentZstandardFrameAllowance = (): ZstandardFrameAllowance =>
  resolveZstandardFrameAllowance(process.env);

/** Facts a work refusal carries so callers do not restate the registry. */
export const zstandardWorkLimitFacts = (
  allowance: ZstandardFrameAllowance,
): {
  readonly reason: "work_limit";
  readonly setting: typeof ZSTD_MAX_FRAMES_SETTING;
  readonly value: number;
  readonly source: ZstandardFrameSource;
  readonly minimum: number;
  readonly maximum: number;
} => ({
  reason: "work_limit",
  setting: ZSTD_MAX_FRAMES_SETTING,
  value: allowance.maxFrames,
  source: allowance.source,
  minimum: MINIMUM_ZSTD_MAX_FRAMES,
  maximum: MAXIMUM_ZSTD_MAX_FRAMES,
});

/**
 * Decoder-work refusal. Distinct from malformed framing: the bytes were not
 * shown to be invalid, and the named setting can admit a larger frame count.
 */
export class ZstandardFrameAllowanceError extends ParseFailureError<"limit"> {
  readonly reason = "work_limit" as const;
  readonly setting = ZSTD_MAX_FRAMES_SETTING;
  readonly value: number;
  readonly source: ZstandardFrameSource;
  readonly minimum: number;
  readonly maximum: number;
  readonly offset: number;

  constructor(allowance: ZstandardFrameAllowance, offset: number) {
    const facts = zstandardWorkLimitFacts(allowance);
    const detail = `${facts.setting} is ${String(facts.value)} (source ${facts.source}, range ${String(facts.minimum)}..${String(facts.maximum)})`;
    super({
      kind: "limit",
      format: "zstd",
      detail,
      offset,
      field: facts.reason,
      limit: {
        name: facts.setting,
        maximum: facts.value,
        required: facts.value + 1,
      },
    });
    this.name = "ZstandardFrameAllowanceError";
    this.value = facts.value;
    this.source = facts.source;
    this.minimum = facts.minimum;
    this.maximum = facts.maximum;
    this.offset = offset;
  }
}
