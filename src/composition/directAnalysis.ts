import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { parseConfig } from "../config.js";
import {
  runDirectAnalysis as executeDirectAnalysis,
  runProviderAnalysis as executeProviderAnalysis,
  runManagedProviderExecution as executeManagedProvider,
} from "../application/DirectAnalysis.js";
import {
  runCapabilityStatus as executeCapabilityStatus,
  runProviderStatus as executeProviderStatus,
} from "../application/DirectAnalysisStatus.js";
import type { DirectAnalysisDependencies } from "../application/DirectAnalysisDependencies.js";
import { createBinarySession, createManagedBinarySession } from "./binary.js";

/** Bind one-shot analysis and status commands to one caller-selected environment. */
export const createDirectAnalysis = (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
) => {
  const environment = snapshotEnvironment(selectedEnvironment);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig(environment),
    createBinarySession: (config, logger) =>
      createBinarySession(config, logger, environment),
    createManagedBinarySession,
  };
  return {
    runDirectAnalysis: executeDirectAnalysis.bind(undefined, dependencies),
    runProviderAnalysis: executeProviderAnalysis.bind(undefined, dependencies),
    runProviderStatus: executeProviderStatus.bind(undefined, dependencies),
    runCapabilityStatus: executeCapabilityStatus.bind(undefined, dependencies),
  };
};

/** Bound operations used by CLI command registration. */
export type DirectAnalysis = ReturnType<typeof createDirectAnalysis>;

/** Execute managed metadata without configuration or native provider candidates. */
export const runManagedProviderExecution = executeManagedProvider.bind(
  undefined,
  {
    createManagedBinarySession,
  },
);
