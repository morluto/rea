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
 * A producer whose omitted output budget and maximum differ from the shared
 * setting. The setting's built-in default is not applied: that would replace
 * the producer's own default. An explicit runtime value or launch seed is
 * clamped to `maximum`.
 */
export interface ProducerOutputCeiling {
  readonly defaultValue: number;
  readonly maximum: number;
}

const clamp = (value: number, ceiling: ProducerOutputCeiling | undefined) =>
  ceiling === undefined ? value : Math.min(value, ceiling.maximum);

/**
 * The caller's `producer_limits.output_bytes`, then the runtime override, then
 * the launch seed, then the built-in default. An invalid seed is refused; it
 * is not replaced by the default. With a ceiling, an unset setting keeps that
 * producer's default instead of the shared 4 MiB default.
 */
export const resolveProducerOutputBytes = (
  request: number | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  ceiling?: ProducerOutputCeiling,
): Result<ProducerOutputBytes, ConfigurationError> => {
  if (request !== undefined) return ok({ value: request, source: "request" });
  const override = currentAnalysisSettingOverride(
    PRODUCER_OUTPUT_BYTES_SETTING,
  );
  if (override !== undefined)
    return ok({ value: clamp(override, ceiling), source: "runtime" });
  const launched = launchAnalysisSetting(
    PRODUCER_OUTPUT_BYTES_SETTING,
    environment,
  );
  if (!launched.ok) return err(launched.error);
  // The definition has a numeric default, so the launch value is never null.
  const source = launched.value.source;
  if (ceiling !== undefined && source === "default")
    return ok({ value: ceiling.defaultValue, source: "default" });
  return ok({
    value: clamp(launched.value.value ?? 0, ceiling),
    source,
  });
};

/**
 * The setting-backed control a refusal at this budget reports. `maximum`
 * tightens the advertised range to a producer's own cap when that cap is
 * below the shared setting maximum.
 */
export const producerOutputBytesLimit = (
  budget: ProducerOutputBytes,
  maximum?: number,
): AnalysisSettingLimit => {
  const limit = analysisSettingLimit(
    PRODUCER_OUTPUT_BYTES_SETTING,
    budget.value,
    budget.source,
  );
  return maximum === undefined
    ? limit
    : { ...limit, maximum: Math.min(limit.maximum, maximum) };
};
