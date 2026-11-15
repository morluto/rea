import {
  DEFAULT_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
  MAXIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
  MINIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
} from "../domain/analysisResourceLimits.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

export const CAPTURE_PACKET_JSON_EXPANSION_SETTING =
  "REA_CAPTURE_PACKET_JSON_EXPANSION_BYTES";

/** Effective packet-capture JSON expansion budget and where it came from. */
export interface CapturePacketJsonExpansion {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

const constraint = `${CAPTURE_PACKET_JSON_EXPANSION_SETTING} must be a decimal integer from ${String(MINIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES)} to ${String(MAXIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES)} bytes; the default is ${String(DEFAULT_CAPTURE_PACKET_JSON_EXPANSION_BYTES)} bytes.`;

/** Optional decimal byte count for the packet-capture JSON expansion budget. */
export const capturePacketJsonExpansionBytesSchema =
  positiveDecimalIntegerSchema(
    MINIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
    MAXIMUM_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
    constraint,
  );

/**
 * Resolve the budget for one packet-capture request: a runtime override wins,
 * then the launch seed, then the default. A malformed seed is refused, not
 * ignored.
 */
export const resolveCapturePacketJsonExpansion = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<CapturePacketJsonExpansion, ConfigurationError> => {
  const override = currentAnalysisSettingOverride(
    "capture.packet_json_expansion_bytes",
  );
  if (override !== undefined)
    return ok({ maximumBytes: override, source: "runtime" });
  const value = environment[CAPTURE_PACKET_JSON_EXPANSION_SETTING];
  if (value === undefined)
    return ok({
      maximumBytes: DEFAULT_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
      source: "default",
    });
  const parsed = capturePacketJsonExpansionBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(constraint, {
          settings: [
            { setting: CAPTURE_PACKET_JSON_EXPANSION_SETTING, constraint },
          ],
        }),
      );
};

/**
 * Refuse a packet-capture reply whose estimated expansion exceeds the budget.
 * The typed `adjustable_budget` refusal names the setting and owns recovery.
 */
export const capturePacketJsonExpansionError = (
  operation: string,
  budget: CapturePacketJsonExpansion,
  capturedOutput: AnalysisCapturedOutput | undefined,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    `TShark JSON expansion exceeds the capture.packet_json_expansion_bytes budget of ${String(budget.maximumBytes)} bytes; the packets were not parsed.`,
    { max_decoded_bytes: budget.maximumBytes },
    {
      retryable: false,
      limit: analysisSettingLimit(
        "capture.packet_json_expansion_bytes",
        budget.maximumBytes,
        budget.source,
      ),
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    },
  );
