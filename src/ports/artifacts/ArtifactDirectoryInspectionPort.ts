import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { Result } from "../../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
  RetainedResourceScope,
} from "../AnalysisProvider.js";

/**
 * Inventory a caller-selected directory as `inspect_artifact` does, without
 * a session target. The execution's subject is the directory's complete
 * tree digest, or none when the walk was partial. Resources whose cleanup
 * failed stay in `retained`, the caller's lifetime, for a later retry.
 */
export type InspectArtifactDirectory = (
  path: string,
  parameters: Readonly<Record<string, JsonValue>>,
  options?: ExecutionOptions,
  retained?: RetainedResourceScope,
) => Promise<Result<AnalysisExecution, AnalysisError>>;
