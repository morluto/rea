import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, type Result } from "../../domain/result.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisClient, ExecutionOptions } from "../AnalysisProvider.js";

/** Close one provider client and normalize unexpected adapter rejection. */
export const closeAnalysisClient = async (
  client: AnalysisClient,
  providerId: string,
  options: Pick<ExecutionOptions, "progress"> & {
    readonly retainDocument?: boolean;
  } = {},
): Promise<Result<null, AnalysisError>> => {
  try {
    return await client.close(options);
  } catch (cause: unknown) {
    // A typed cleanup failure already names its leftover resources.
    if (cause instanceof AnalysisError && cause.cleanupIncomplete)
      return err(cause);
    return err(
      new ProviderCleanupError(
        providerId,
        ["provider-client"],
        { reason: "provider client close rejected unexpectedly" },
        { cause },
      ),
    );
  }
};
