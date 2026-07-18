import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { Logger } from "../logger.js";

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

export const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
) => ({
  logger,
  snapshotPath,
  ...(providerId === undefined ? {} : { providerId }),
});
