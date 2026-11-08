import type {
  JavaScriptSemanticProjectionCapacity,
  JavaScriptSemanticFileProjection,
} from "./javascriptSemanticFileProjection.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { Result } from "../result.js";
import type { ApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptArtifactFile } from "./javascriptArtifactFiles.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptModuleSemanticIr } from "./javascriptModuleSemanticIr.js";
import type { JavaScriptPackageType } from "./javascriptSourceParser.js";

/** An earlier static projection displaced to retain later static observations. */
export interface JavaScriptRevokedStaticProjection {
  /** Zero-based source-analysis call index within this worker checkout. */
  readonly sourceIndex: number;
  readonly error: AnalysisResourceConstraintError;
}

/** Portable facts collected from one inert source. */
export interface JavaScriptAnalyzedSource {
  readonly javascript: JavaScriptStaticAnalysis;
  readonly module: JavaScriptModuleSemanticIr | null;
  readonly projection: JavaScriptSemanticFileProjection | null;
  readonly applicationProjectionFailure?: AnalysisResourceConstraintError;
  readonly revokedStaticProjections?: readonly JavaScriptRevokedStaticProjection[];
}

/** Execution failure alongside facts already collected by the consumer. */
export interface JavaScriptSourceAnalysisFailure {
  readonly error: AnalysisError;
  readonly javascript: JavaScriptStaticAnalysis | null;
  readonly module: JavaScriptModuleSemanticIr | null;
  readonly projection: JavaScriptSemanticFileProjection | null;
  readonly applicationProjectionFailure?: AnalysisResourceConstraintError;
  readonly revokedStaticProjections?: readonly JavaScriptRevokedStaticProjection[];
}

/** Operational choices for source analysis, independent of transport framing. */
export interface JavaScriptSourceAnalysisLimits {
  readonly heapMb: number;
  readonly timeoutMs: number;
}

/** Admission costs measured for a selected source before analysis starts. */
export interface JavaScriptSourceAdmission {
  readonly bytes: number;
  readonly rootBytes: number;
}

/** Give the current source its root and a share of capacity left after later roots. */
export const semanticSourceBudget = (input: {
  readonly remaining: number;
  readonly rootBytes: number;
  readonly laterRootBytes: number;
  readonly sourceBytes: number;
  readonly sourceBytesRemaining: number;
  readonly laterSources: number | undefined;
}): number => {
  if (input.laterSources === 0) return input.remaining;
  const root = Math.min(input.rootBytes, input.remaining);
  const surplus = Math.max(0, input.remaining - root - input.laterRootBytes);
  const share =
    input.sourceBytesRemaining === 0
      ? Math.floor(surplus / ((input.laterSources ?? 0) + 1))
      : Math.floor((surplus * input.sourceBytes) / input.sourceBytesRemaining);
  return root + share;
};

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
  /** Capacity offered to this source after accounting for retained facts. */
  analyze(
    file: JavaScriptArtifactFile,
    capacity: JavaScriptSemanticProjectionCapacity,
    signal?: AbortSignal,
    onPhase?: (phase: string) => Promise<void>,
    /** Effective package/loader context; declared .js preloads use commonjs. */
    packageType?: JavaScriptPackageType,
    /** Discover loader declarations without retaining semantic projections. */
    purpose?: "analysis" | "preload-discovery",
  ): Promise<Result<JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure>>;
  /** Limits that offered each analyzed source its semantic-fact byte budget. */
  coverageLimits(): ApplicationCoverage["limits"];
  close(): Promise<void>;
}
