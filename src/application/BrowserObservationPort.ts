import type { AnalysisError } from "../domain/errors.js";
import type {
  BrowserTargetList,
  InspectWebPageInput,
  ListBrowserTargetsInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { Result } from "../domain/result.js";
import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";

/** Provider-neutral application boundary for passive browser observation. */
export interface BrowserObservationPort {
  identity(): ProviderIdentity;
  listTargets(
    input: ListBrowserTargetsInput,
    options?: ExecutionOptions,
  ): Promise<Result<BrowserTargetList, AnalysisError>>;
  inspectPage(
    input: InspectWebPageInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebPageInspection, AnalysisError>>;
}
