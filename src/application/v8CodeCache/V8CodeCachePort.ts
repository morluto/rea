import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectV8CodeCacheInput,
  V8CodeCache,
} from "../../domain/v8/v8CodeCache.js";

/** Stable read and V8 code cache container decoding, independent of a V8 runtime. */
export interface V8CodeCachePort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectV8CodeCacheInput,
    options?: ExecutionOptions,
  ): Promise<Result<V8CodeCache, AnalysisError>>;
}
