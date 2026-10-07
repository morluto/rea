import type {
  JavaScriptSourceRange,
  JavaScriptStaticAnalysis,
} from "../../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticIr } from "../../domain/javascriptSemanticIr.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

interface JavaScriptStructuredObservation {
  readonly path: string;
  readonly sha256: string;
}

interface JavaScriptPackageValues {
  readonly name: string | null;
  readonly version: string | null;
  readonly main: string | null;
  readonly renderer: string | null;
}

/** Parsed package metadata used only for static entrypoint discovery. */
export type JavaScriptPackageObservation = JavaScriptStructuredObservation &
  (
    | (JavaScriptPackageValues & {
        readonly status: "included";
        readonly limitation: null;
      })
    | {
        readonly status: "invalid" | "unavailable";
        readonly name: null;
        readonly version: null;
        readonly main: null;
        readonly renderer: null;
        readonly limitation: string;
      }
  );

/** One HTML script source observed without building or executing a DOM. */
export interface JavaScriptHtmlScriptObservation {
  readonly html_path: string;
  readonly script_path: string;
  readonly base_href: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One original source declared by a local source map. */
export interface JavaScriptSourceMapOriginal {
  readonly source: string;
  readonly content: string | null;
  readonly content_sha256: string | null;
}

/** Local source-map parse result. */
export type JavaScriptSourceMapObservation = JavaScriptStructuredObservation &
  (
    | {
        readonly status: "included";
        readonly sources: readonly JavaScriptSourceMapOriginal[];
        readonly limitation: null;
      }
    | {
        readonly status: "invalid";
        readonly sources: readonly [];
        readonly limitation: string;
      }
  );

/** Parse status for one inventoried JSON module. */
export type JavaScriptJsonModuleObservation = JavaScriptStructuredObservation &
  (
    | {
        readonly status: "included";
        readonly top_level_keys: readonly string[];
        readonly omitted_top_level_keys: number;
        readonly limitation: null;
      }
    | {
        readonly status: "invalid";
        readonly top_level_keys: readonly [];
        readonly omitted_top_level_keys: 0;
        readonly limitation: string;
      }
    | {
        readonly status: "unavailable";
        readonly top_level_keys: readonly [];
        readonly omitted_top_level_keys: null;
        readonly limitation: string;
      }
  );

/** One relevant file plus optional AST-only JavaScript facts. */
export interface AnalyzedJavaScriptArtifactFile {
  readonly file: JavaScriptArtifactFile;
  readonly javascript: JavaScriptStaticAnalysis | null;
  readonly semantic: {
    readonly ir: JavaScriptSemanticIr;
  } | null;
}

/** Complete static-analysis projection before graph construction. */
export interface JavaScriptArtifactAnalysis {
  readonly files: readonly AnalyzedJavaScriptArtifactFile[];
  readonly packages: readonly JavaScriptPackageObservation[];
  readonly json_modules: readonly JavaScriptJsonModuleObservation[];
  readonly html_scripts: readonly JavaScriptHtmlScriptObservation[];
  readonly source_maps: readonly JavaScriptSourceMapObservation[];
  readonly visited_ast_nodes: number;
  readonly findings: number;
  readonly modules: number;
  readonly parse_failures: number;
  readonly truncated_scopes: number;
  readonly limitations: readonly string[];
}
