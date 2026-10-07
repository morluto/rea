import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BinarySession } from "./binary/BinarySession.js";

/** Existing one-shot session factories supplied by the production boundary. */
export interface DirectAnalysisDependencies {
  readonly createBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySession;
  readonly createManagedBinarySession: () => BinarySession;
}
