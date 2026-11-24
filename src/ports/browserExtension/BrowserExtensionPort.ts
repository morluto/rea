import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  BrowserExtensionReport,
  InspectBrowserExtensionInput,
} from "../../domain/browserExtension/browserExtension.js";
import type { Result } from "../../domain/result.js";

/** Stable read and extension-manifest projection, with no browser or network. */
export interface BrowserExtensionPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectBrowserExtensionInput,
    options?: ExecutionOptions,
  ): Promise<Result<BrowserExtensionReport, AnalysisError>>;
}
