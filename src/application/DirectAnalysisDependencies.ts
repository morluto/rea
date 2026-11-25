import type { AppConfig } from "../config/types.js";
import type { parseConfig } from "../config/parseConfig.js";
import type { Logger } from "pino";
import type { BinarySession } from "./binary/BinarySession.js";
import type { ManagedBinarySessionPort } from "./binary/BinarySessionPort.js";
import type { InspectArtifactDirectory } from "../ports/artifacts/ArtifactDirectoryInspectionPort.js";

/** Configuration and one-shot session factories supplied by the production boundary. */
export interface DirectAnalysisDependencies {
  /** Read the caller-selected configuration without consulting ambient state. */
  readonly readConfiguration: () => ReturnType<typeof parseConfig>;
  readonly createBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySession | Promise<BinarySession>;
  /** Prefer byte-backed dispatch inspection while preserving explicit selection. */
  readonly createNativeDispatchBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySession | Promise<BinarySession>;
  /** Create an artifact-only session without selecting native analysis engines. */
  readonly createArtifactBinarySession: () =>
    | BinarySession
    | Promise<BinarySession>;
  /** Inventory a selected directory for `inspect_artifact` without a session target; absent, directories are refused as targets. */
  readonly inspectArtifactDirectory?: InspectArtifactDirectory;
  /** Create a native utility session without selecting deep analysis engines. */
  readonly createNativeBinarySession: () =>
    | BinarySession
    | Promise<BinarySession>;
  readonly createManagedBinarySession: () =>
    | ManagedBinarySessionPort
    | Promise<ManagedBinarySessionPort>;
}
