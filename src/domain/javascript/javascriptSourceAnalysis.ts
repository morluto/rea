import type { AnalysisError } from "../analysisErrorBase.js";
import type { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { Result } from "../result.js";
import type { ApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptArtifactFile } from "./javascriptArtifactFiles.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptModuleSemanticIr } from "./javascriptModuleSemanticIr.js";
import type { JavaScriptSemanticFileProjection } from "./javascriptSemanticFileProjection.js";

/** Portable facts collected from one inert source. */
export interface JavaScriptAnalyzedSource {
  readonly javascript: JavaScriptStaticAnalysis;
  readonly module: JavaScriptModuleSemanticIr | null;
  readonly projection: JavaScriptSemanticFileProjection | null;
  readonly applicationProjectionFailure?: AnalysisResourceConstraintError;
}

/** Execution failure alongside facts already collected by the consumer. */
export interface JavaScriptSourceAnalysisFailure {
  readonly error: AnalysisError;
  readonly javascript: JavaScriptStaticAnalysis | null;
  readonly module: JavaScriptModuleSemanticIr | null;
  readonly projection: JavaScriptSemanticFileProjection | null;
  readonly applicationProjectionFailure?: AnalysisResourceConstraintError;
}

/** Operational choices for source analysis, independent of transport framing. */
export interface JavaScriptSourceAnalysisLimits {
  readonly heapMb: number;
  readonly timeoutMs: number;
}

/** One owner for serialized Evidence capacity shared with final projection. */
export interface JavaScriptEvidenceAdmission {
  remainingBytes(): number;
  reserveBytes(bytes: number): boolean;
  releaseBytes(bytes: number): void;
}

/** Sequential source-analysis authority with independently verified cleanup. */
export interface JavaScriptSourceAnalysisPort {
  readonly evidenceBudget?: JavaScriptEvidenceAdmission;
  /** Release estimates superseded by actual application-graph admission. */
  releaseApplicationGraphForecast?(): void;
  /** `nodeBudget` is the caller-selected node capacity offered to this source, or null. */
  analyze(
    file: JavaScriptArtifactFile,
    nodeBudget: number | null,
    signal?: AbortSignal,
  ): Promise<Result<JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure>>;
  /** Limits that offered each analyzed source its semantic-fact byte budget. */
  coverageLimits(): ApplicationCoverage["limits"];
  close(): Promise<void>;
}
