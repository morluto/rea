import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectHwpDocumentInput } from "../../domain/hwp/hwpDocument.js";
import type { Result } from "../../domain/result.js";

/** HWP document inspection boundary shared by CLI and MCP. */
export interface HwpDocumentPort {
  /** Await provider-owned cleanup. */
  close?(): Promise<void>;
  inspect(
    input: InspectHwpDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
