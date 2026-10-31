import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectWindowsMinidumpInput,
  WindowsMinidump,
} from "../../domain/native/windowsMinidump.js";
import type { Result } from "../../domain/result.js";

/** Stable read and decoding of a supplied recording; never acquires a live target. */
export interface WindowsMinidumpPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectWindowsMinidumpInput,
    options?: ExecutionOptions,
  ): Promise<Result<WindowsMinidump, AnalysisError>>;
}
