import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import {
  ARTIFACT_MEMBER_COUNT_SETTING,
  DEFAULT_ARTIFACT_MEMBER_COUNT,
  MAXIMUM_ARTIFACT_READER_COUNT,
  type ArtifactMemberCount,
} from "../domain/artifactReaderLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";

/** The ZIP reader field `artifact.member_count` supplies when a call has no `artifact_limits`. */
export const ZIP_MEMBER_COUNT_PARAMETER = "artifact_limits.zip.member_count";

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

/**
 * Member count for a ZIP reader whose caller has no `artifact_limits` field.
 * Flutter APK inventory, Playwright trace import, and SAZ decoding use this.
 */
export const operationZipMemberCount = (): number =>
  runtimeArtifactMemberCount(process.env).value;

/**
 * A central-directory count refusal. The reader's message stays a count.
 * Recovery names `artifact.member_count`, the setting that supplied the cap.
 */
export const zipMemberCountRefusal = (
  operation: string,
  message: string,
  effectiveValue: number,
  cause?: unknown,
): AnalysisResourceConstraintError => {
  const resolved = runtimeArtifactMemberCount(process.env);
  return new AnalysisResourceConstraintError(
    operation,
    "capacity",
    message,
    { member_count: effectiveValue },
    {
      ...(cause === undefined ? {} : { cause }),
      retryable: false,
      limit: {
        ...analysisSettingLimit(
          ARTIFACT_MEMBER_COUNT_SETTING,
          effectiveValue,
          resolved.source,
        ),
        parameter: ZIP_MEMBER_COUNT_PARAMETER,
      },
    },
  );
};

/** The public count refusal when this reader limit is the ZIP member count. */
export const zipMemberCountConstraint = (
  operation: string,
  cause: {
    readonly message: string;
    readonly readerLimit?:
      | { readonly parameter: string; readonly effective_value: number }
      | undefined;
  },
): AnalysisResourceConstraintError | undefined => {
  const limit = cause.readerLimit;
  if (limit?.parameter !== ZIP_MEMBER_COUNT_PARAMETER) return undefined;
  return zipMemberCountRefusal(
    operation,
    cause.message,
    limit.effective_value,
    cause,
  );
};
