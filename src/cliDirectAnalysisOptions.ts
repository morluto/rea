import type { z } from "incur";

import type { Logger } from "./logger.js";
import {
  analysisProviderSelectorSchema,
  type AnalysisProviderSelector,
} from "./contracts/providerSelection.js";

/** Shared provider selector used by every one-shot deep-analysis command. */
export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Project parsed CLI options into the direct-analysis application boundary. */
export const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
): {
  readonly logger: Logger;
  readonly snapshotPath: string | undefined;
  readonly providerId?: z.output<typeof analysisProviderSelectorSchema>;
} => ({
  logger,
  snapshotPath,
  ...(providerId === undefined ? {} : { providerId }),
});
