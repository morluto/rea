import type {
  JavaScriptSourceAnalysisLimits,
  JavaScriptSourceAnalysisPort,
} from "../../domain/javascript/javascriptSourceAnalysis.js";
import type { ArtifactResourceScope } from "../../resources/index.js";

/**
 * Acquire a bounded JavaScript source analyzer for one artifact analysis.
 * Composition binds the provider's worker; application never constructs it.
 * The analyzer is inert until its first source and may reuse a healthy worker
 * parked on `scope`, which owns that worker until the scope closes.
 */
export type JavaScriptSourceAnalysisFactory = (
  limits: JavaScriptSourceAnalysisLimits,
  sourceCount: number,
  acquisition: { readonly scope: ArtifactResourceScope },
) => Promise<JavaScriptSourceAnalysisPort>;
