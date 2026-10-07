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

const dependencies: DirectAnalysisDependencies = {
  createBinarySession,
  createManagedBinarySession,
};

/** Run one isolated binary operation through the production session factory. */
export const runDirectAnalysis = executeDirectAnalysis.bind(
  undefined,
  dependencies,
);

/** Run one isolated native, artifact or managed operation. */
export const runProviderAnalysis = executeProviderAnalysis.bind(
  undefined,
  dependencies,
);

/** Execute managed metadata without constructing native provider candidates. */
export const runManagedProviderExecution = executeManagedProvider.bind(
  undefined,
  dependencies,
);

/** Report production provider candidates without opening a target. */
export const runProviderStatus = executeProviderStatus.bind(
  undefined,
  dependencies,
);

/** Report production session operations without opening a target. */
export const runCapabilityStatus = executeCapabilityStatus.bind(
  undefined,
  dependencies,
);
