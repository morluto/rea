import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectWindowsShortcutInput,
  WindowsShortcut,
} from "../../domain/native/windowsShortcut.js";
import type { Result } from "../../domain/result.js";

/** Stable read and Shell Link decoding, independent of a disassembler session. */
export interface WindowsShortcutPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectWindowsShortcutInput,
    options?: ExecutionOptions,
  ): Promise<Result<WindowsShortcut, AnalysisError>>;
}
