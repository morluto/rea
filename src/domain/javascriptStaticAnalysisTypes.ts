import type { ElectronStaticFindings } from "./electronStaticAnalysisTypes.js";

/** One source coordinate produced by the JavaScript parser. */
export interface JavaScriptSourcePoint {
  readonly line: number;
  readonly column: number;
}

/** One exact source range within a bounded JavaScript artifact. */
export interface JavaScriptSourceRange {
  readonly start: JavaScriptSourcePoint;
  readonly end: JavaScriptSourcePoint;
}

/** A statically visible module, worker, or service-worker reference. */
export interface JavaScriptStaticReference {
  readonly kind:
    | "static-import"
    | "dynamic-import"
    | "require"
    | "worker"
    | "service-worker";
  readonly specifier: string | null;
  readonly expression: string | null;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** A route or network endpoint literal observed in syntax. */
export interface JavaScriptStaticEndpoint {
  readonly kind: "route" | "network";
  readonly value: string;
  readonly mechanism: string;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** A storage surface observed without executing application code. */
export interface JavaScriptStaticStorage {
  readonly kind:
    | "local-storage"
    | "session-storage"
    | "indexed-db"
    | "cache-storage"
    | "sqlite";
  readonly name: string | null;
  readonly mechanism: string;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One exact module factory recovered from a Webpack/Rspack registration. */
export interface JavaScriptBundlerModule {
  readonly module_key: string;
  readonly source_sha256: string;
  readonly structural_fingerprint_sha256: string | null;
  readonly structural_fingerprint_algorithm: "babel-ast-v1" | null;
  readonly structural_fingerprint_status: "complete" | "truncated";
  readonly exports: readonly string[];
  readonly exports_truncated: boolean;
  readonly location: JavaScriptSourceRange;
}

/** One statically recognized Webpack/Rspack chunk registration. */
export interface JavaScriptBundlerRegistration {
  readonly bundler: "webpack" | "rspack";
  readonly runtime: string;
  readonly chunk_keys: readonly string[];
  readonly omitted_chunk_keys: number;
  readonly unknown_chunk_keys: number;
  readonly modules: readonly JavaScriptBundlerModule[];
  readonly location: JavaScriptSourceRange;
}

/** Static Electron role paths discovered from package or JavaScript syntax. */
export interface JavaScriptRolePath {
  readonly role: "preload" | "renderer";
  readonly path: string;
  readonly mechanism: string;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** Bounded, deterministic AST-only analysis of one JavaScript source file. */
export interface JavaScriptStaticAnalysis {
  readonly parse_status: "complete" | "partial" | "failed" | "truncated";
  readonly parse_error_count: number;
  readonly visited_ast_nodes: number;
  readonly dropped_findings: number;
  readonly references: readonly JavaScriptStaticReference[];
  readonly endpoints: readonly JavaScriptStaticEndpoint[];
  readonly storage: readonly JavaScriptStaticStorage[];
  readonly bundler_registrations: readonly JavaScriptBundlerRegistration[];
  readonly role_paths: readonly JavaScriptRolePath[];
  readonly source_map_urls: readonly {
    readonly declared_url: string;
    readonly location: JavaScriptSourceRange;
  }[];
  readonly vendors: readonly string[];
  readonly electron: ElectronStaticFindings;
  readonly limitations: readonly string[];
}

/** Hard bounds applied to one AST-only JavaScript analysis. */
export interface JavaScriptStaticAnalysisLimits {
  readonly maxAstNodes: number;
  readonly maxFindings: number;
  readonly maxModules: number;
  readonly deadline: number;
  readonly now: () => number;
}
