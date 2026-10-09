import type { AppConfig, parseConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BinarySession } from "./binary/BinarySession.js";

/** Configuration and one-shot session factories supplied by the production boundary. */
export interface DirectAnalysisDependencies {
  /** Read the caller-selected configuration without consulting ambient state. */
  readonly readConfiguration: () => ReturnType<typeof parseConfig>;
  readonly createBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySession;
  readonly createManagedBinarySession: () => BinarySession;
}
