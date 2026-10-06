import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { Logger } from "../logger.js";

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Explicit interpretation for headerless native executable formats. */
export const formatSelectionOption = executableFormatHintSchema
  .optional()
  .describe("Explicit headerless DOS COM interpretation");

export const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
  formatHint?: ExecutableFormatHint,
) => ({
  logger,
  snapshotPath,
  ...(formatHint === undefined ? {} : { formatHint }),
  ...(providerId === undefined ? {} : { providerId }),
});
