import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import {
  ARTIFACT_MEMBER_COUNT_SETTING,
  DEFAULT_ARTIFACT_MEMBER_COUNT,
  MAXIMUM_ARTIFACT_READER_COUNT,
  type ArtifactMemberCount,
} from "../domain/artifactReaderLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";

const CONSTRAINT = `REA_ARTIFACT_MEMBER_COUNT must be a decimal integer from 1 to ${String(MAXIMUM_ARTIFACT_READER_COUNT)} members; the default is ${String(DEFAULT_ARTIFACT_MEMBER_COUNT)}.`;

/** Launch seed for `artifact.member_count`, shared with launch admission. */
export const artifactMemberCountSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_ARTIFACT_READER_COUNT,
  CONSTRAINT,
);

/**
 * The session member count one artifact operation applies: a runtime override,
 * then the launch seed, then the default. An invalid seed is refused rather
 * than replaced by the default.
 */
export const runtimeArtifactMemberCount = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): ArtifactMemberCount => {
  const override =
    read?.().overrides[ARTIFACT_MEMBER_COUNT_SETTING] ??
    currentAnalysisSettingOverride(ARTIFACT_MEMBER_COUNT_SETTING);
  if (override !== undefined) return { value: override, source: "runtime" };
  const raw = environment.REA_ARTIFACT_MEMBER_COUNT;
  if (raw === undefined)
    return { value: DEFAULT_ARTIFACT_MEMBER_COUNT, source: "default" };
  const parsed = artifactMemberCountSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigurationError(CONSTRAINT, {
      remediationAction: `On a running MCP session, call update_analysis_settings for ${ARTIFACT_MEMBER_COUNT_SETTING}, then retry. For CLI or future REA processes, correct REA_ARTIFACT_MEMBER_COUNT in the launch environment.`,
      settings: [
        {
          setting: "REA_ARTIFACT_MEMBER_COUNT",
          constraint: CONSTRAINT,
          update_mode: "runtime",
          pending_restart: false,
        },
      ],
    });
  return { value: parsed.data, source: "setting" };
};
