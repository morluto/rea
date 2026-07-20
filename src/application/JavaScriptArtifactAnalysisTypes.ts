import type {
  JavaScriptSourceRange,
  JavaScriptStaticAnalysis,
} from "../domain/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptSemanticIr,
  JavaScriptSemanticLimits,
} from "../domain/javascriptSemanticIr.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

/** Parsed package metadata used only for static entrypoint discovery. */
export interface JavaScriptPackageObservation {
  readonly path: string;
  readonly sha256: string;
  readonly status: "included" | "invalid" | "unavailable";
  readonly name: string | null;
  readonly version: string | null;
  readonly main: string | null;
  readonly renderer: string | null;
  readonly limitation: string | null;
}

/** One HTML script source observed without building or executing a DOM. */
export interface JavaScriptHtmlScriptObservation {
  readonly html_path: string;
  readonly script_path: string;
  readonly base_href: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One original source declared by an approved local source map. */
export interface JavaScriptSourceMapOriginal {
  readonly source: string;
  readonly content: string | null;
  readonly content_sha256: string | null;
}

/** Bounded local source-map parse result. */
export interface JavaScriptSourceMapObservation {
  readonly path: string;
  readonly sha256: string;
  readonly status: "included" | "truncated" | "invalid" | "not-approved";
  readonly sources: readonly JavaScriptSourceMapOriginal[];
  readonly omitted_sources: number | null;
  readonly limitation: string | null;
}

/** Bounded parse status for one inventoried JSON module. */
export interface JavaScriptJsonModuleObservation {
  readonly path: string;
  readonly sha256: string;
  readonly status: "included" | "invalid" | "unavailable";
  readonly top_level_keys: readonly string[];
  readonly omitted_top_level_keys: number | null;
  readonly limitation: string | null;
}

/** One bounded entry recovered from a bundler manifest or metafile. */
export interface JavaScriptBundlerManifestEntry {
  readonly key: string;
  readonly source: string | null;
  readonly file: string | null;
  readonly entry: boolean | null;
  readonly imports: readonly string[];
  readonly dynamic_imports: readonly string[];
  readonly css: readonly string[];
  readonly assets: readonly string[];
}

/** Bounded Vite/Rollup manifest or esbuild metafile parse result. */
export interface JavaScriptBundlerManifestObservation {
  readonly path: string;
  readonly sha256: string;
  readonly status: "included" | "truncated" | "invalid" | "unavailable";
  readonly bundler: "vite" | "rollup" | "esbuild";
  readonly manifest_kind:
    | "vite-manifest"
    | "rollup-manifest"
    | "esbuild-metafile";
  readonly entries: readonly JavaScriptBundlerManifestEntry[];
  readonly omitted_entries: number | null;
  readonly limitation: string | null;
}

/** One relevant file plus optional AST-only JavaScript facts. */
export interface AnalyzedJavaScriptArtifactFile {
  readonly file: JavaScriptArtifactFile;
  readonly javascript: JavaScriptStaticAnalysis | null;
  readonly semantic: {
    readonly ir: JavaScriptSemanticIr;
    readonly limits: JavaScriptSemanticLimits;
  } | null;
}

/** Complete bounded static-analysis projection before graph construction. */
export interface JavaScriptArtifactAnalysis {
  readonly files: readonly AnalyzedJavaScriptArtifactFile[];
  readonly packages: readonly JavaScriptPackageObservation[];
  readonly json_modules: readonly JavaScriptJsonModuleObservation[];
  readonly bundler_manifests: readonly JavaScriptBundlerManifestObservation[];
  readonly html_scripts: readonly JavaScriptHtmlScriptObservation[];
  readonly source_maps: readonly JavaScriptSourceMapObservation[];
  readonly visited_ast_nodes: number;
  readonly findings: number;
  readonly modules: number;
  readonly parse_failures: number;
  readonly truncated_scopes: number;
  readonly limitations: readonly string[];
}
