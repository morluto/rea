import { launchAnalysisSetting } from "./analysisSettings.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import type { AnalysisSettingLimit } from "../domain/analysisSettings.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Registered setting for the shared bounded-producer output budget. */
export const PRODUCER_OUTPUT_BYTES_SETTING = "producer.output_bytes" as const;

/** The output budget one bounded-producer call enforces, and where it came from. */
export interface ProducerOutputBytes {
  readonly value: number;
  readonly source: NonNullable<AnalysisSettingLimit["source"]>;
}

/**
 * The caller's `producer_limits.output_bytes`, then the runtime override, then
 * the launch seed, then the built-in default. An invalid seed is refused; it
 * is not replaced by the default.
 */
export const resolveProducerOutputBytes = (
  request: number | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Result<ProducerOutputBytes, ConfigurationError> => {
  if (request !== undefined) return ok({ value: request, source: "request" });
  const override = currentAnalysisSettingOverride(
    PRODUCER_OUTPUT_BYTES_SETTING,
  );
  if (override !== undefined) return ok({ value: override, source: "runtime" });
  const launched = launchAnalysisSetting(
    PRODUCER_OUTPUT_BYTES_SETTING,
    environment,
  );
  if (!launched.ok) return err(launched.error);
  // The definition has a numeric default, so the launch value is never null.
  return ok({
    value: launched.value.value ?? 0,
    source: launched.value.source,
  });
};

/** The setting-backed control a refusal at this budget reports. */
export const producerOutputBytesLimit = (
  budget: ProducerOutputBytes,
): AnalysisSettingLimit =>
  analysisSettingLimit(
    PRODUCER_OUTPUT_BYTES_SETTING,
    budget.value,
    budget.source,
  );
