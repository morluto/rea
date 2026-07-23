import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisError } from "../domain/errors.js";
import type { AnalysisClient, ExecutionOptions } from "./AnalysisProvider.js";

/** Close one provider client and normalize unexpected adapter rejection. */
export const closeAnalysisClient = async (
  client: AnalysisClient,
  providerId: string,
  options: Pick<ExecutionOptions, "progress"> = {},
): Promise<Result<null, AnalysisError>> => {
  try {
    if (client.closeWithOutcome !== undefined)
      return await client.closeWithOutcome(options);
    await client.close();
    return ok(null);
  } catch (cause: unknown) {
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
