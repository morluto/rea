import { AnalysisCleanupRelease } from "../../src/domain/analysisCleanupRelease.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";

/**
 * Act as the owner of `error`'s own resources and record their confirmed
 * release. Errors composed from it read the release when asked; dependencies
 * bound to `error` keep their own records.
 */
export const releaseOwnedCleanup = <T extends AnalysisError>(error: T): T => {
  const release = new AnalysisCleanupRelease();
  release.bind(error);
  release.confirm();
  return error;
};
