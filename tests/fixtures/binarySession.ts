import type { BinaryTarget } from "../../src/domain/binaryTarget.js";
import type { AnalysisError } from "../../src/domain/errors.js";
import type { Result } from "../../src/domain/result.js";
import type {
  AnalysisClientFactory,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProvider,
} from "../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../src/application/BinarySession.js";
import { SessionProviderRouter } from "../../src/application/SessionProviderRouter.js";

type TestBinarySessionOptions = {
  readonly resolveAnalysisProfile?: (
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
};

type TestBinarySessionOptionsOrResolver =
  | TestBinarySessionOptions
  | TestBinarySessionOptions["resolveAnalysisProfile"];

/** Create a focused session around a test-owned provider or client factory. */
export const createTestBinarySession = (
  provider: AnalysisProvider | AnalysisClientFactory,
  optionsOrResolver?: TestBinarySessionOptionsOrResolver,
): BinarySession => {
  const options =
    typeof optionsOrResolver === "function"
      ? { resolveAnalysisProfile: optionsOrResolver }
      : (optionsOrResolver ?? {});
  return new BinarySession(SessionProviderRouter.single(provider, options));
};
