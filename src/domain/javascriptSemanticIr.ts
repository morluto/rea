import type { JavaScriptSourceRange } from "./javascriptStaticAnalysisTypes.js";

/** Hard bounds for one execution-free JavaScript semantic analysis. */
export interface JavaScriptSemanticLimits {
  readonly maxScopes: number;
  readonly maxBindings: number;
  readonly maxCallables: number;
  readonly maxReferences: number;
  readonly maxModuleLinks: number;
  readonly maxReturnSites: number;
  readonly maxValueDepth: number;
  readonly maxUnionValues: number;
  readonly maxObjectProperties: number;
}

/** Conservative defaults for one source file. */
export const DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS: JavaScriptSemanticLimits = {
  maxScopes: 4_096,
  maxBindings: 20_000,
  maxCallables: 20_000,
  maxReferences: 100_000,
  maxModuleLinks: 20_000,
  maxReturnSites: 20_000,
  maxValueDepth: 16,
  maxUnionValues: 32,
  maxObjectProperties: 256,
};

/** Primitive values admitted into the bounded constant lattice. */
export type JavaScriptSemanticPrimitive = string | number | boolean | null;

/** Bounded, execution-free value lattice for JavaScript expressions. */
export type JavaScriptSemanticValue =
  | {
      readonly status: "literal";
      readonly value: JavaScriptSemanticPrimitive;
    }
  | {
      readonly status: "union";
      readonly values: readonly JavaScriptSemanticPrimitive[];
    }
  | {
      readonly status: "object";
      readonly properties: readonly JavaScriptSemanticProperty[];
      readonly unknownProperties: boolean;
      readonly omittedProperties: number | null;
    }
  | {
      readonly status: "array";
      readonly items: readonly JavaScriptSemanticValue[];
      readonly unknownItems: boolean;
      readonly omittedItems: number | null;
    }
  | {
      readonly status: "unknown" | "ambiguous" | "cycle" | "limit-reached";
      readonly reason: string;
    };

/** One statically named object-literal property. */
export interface JavaScriptSemanticProperty {
  readonly name: string;
  readonly value: JavaScriptSemanticValue;
}

/** One exact module origin followed through imports, requires, or aliases. */
export interface JavaScriptModuleOrigin {
  readonly specifier: string;
  readonly importedPath: readonly string[];
}

/** Fail-closed provenance classification for one binding. */
export interface JavaScriptBindingProvenance {
  readonly status:
    | "module"
    | "local"
    | "unknown"
    | "ambiguous"
    | "cycle"
    | "limit-reached";
  readonly origins: readonly JavaScriptModuleOrigin[];
  readonly reason: string | null;
}

/** One lexical scope recovered without executing source. */
export interface JavaScriptSemanticScope {
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly kind: "program" | "function" | "block" | "class" | "catch";
  readonly location: JavaScriptSourceRange;
  readonly bindingsComplete: boolean;
  readonly bindingIds: readonly string[];
}

/** One declaration or assignment contributing to a binding. */
export interface JavaScriptSemanticDefinition {
  readonly kind:
    | "import"
    | "variable"
    | "parameter"
    | "function"
    | "class"
    | "catch"
    | "assignment";
  readonly location: JavaScriptSourceRange;
}

/** One resolved lexical binding plus bounded value and provenance. */
export interface JavaScriptSemanticBinding {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly name: string;
  readonly kind: JavaScriptSemanticDefinition["kind"];
  readonly mutable: boolean;
  readonly definitions: readonly JavaScriptSemanticDefinition[];
  readonly value: JavaScriptSemanticValue;
  readonly provenance: JavaScriptBindingProvenance;
}

/** One identifier use and its fail-closed lexical resolution. */
export interface JavaScriptSemanticReference {
  readonly name: string;
  readonly role: "read" | "write" | "export";
  readonly location: JavaScriptSourceRange;
  readonly bindingId: string | null;
  readonly resolution: "resolved" | "unbound" | "ambiguous" | "unknown";
}

/** Function, class, or method identity without pretending it is a binding. */
export interface JavaScriptSemanticCallable {
  readonly callableId: string;
  readonly kind: "function" | "class" | "method";
  readonly name: string | null;
  readonly containerScopeId: string;
  readonly bodyScopeId: string | null;
  readonly location: JavaScriptSourceRange;
  readonly returnSites: readonly JavaScriptSemanticReturnSite[];
  readonly returnCoverage: JavaScriptSemanticReturnCoverage;
}

/** One direct return expression belonging to exactly one callable. */
export interface JavaScriptSemanticReturnSite {
  readonly location: JavaScriptSourceRange;
  readonly value: JavaScriptSemanticValue;
}

/** Exact retention state for one callable's direct returns. */
interface JavaScriptSemanticReturnCoverage {
  readonly status: "complete" | "partial" | "truncated";
  readonly retainedCount: number;
  readonly omittedCount: number | null;
  readonly limitsReached: readonly (keyof JavaScriptSemanticLimits)[];
}

/** Static import/export relationship retained for cross-file composition. */
export interface JavaScriptSemanticModuleLink {
  readonly kind:
    | "import"
    | "require"
    | "export"
    | "re-export"
    | "commonjs-export";
  readonly specifier: string | null;
  readonly importedName: string | null;
  readonly localName: string | null;
  readonly exportedName: string | null;
  readonly callableId: string | null;
  readonly location: JavaScriptSourceRange;
}

/** Coverage for bounded semantic recovery. */
interface JavaScriptSemanticCoverage {
  readonly status: "complete" | "partial" | "truncated" | "failed";
  readonly omittedCount: number | null;
  readonly limitsReached: readonly (keyof JavaScriptSemanticLimits)[];
}

/** Provider-neutral JavaScript semantic IR v2. */
export interface JavaScriptSemanticIr {
  readonly schema: "JavaScriptSemanticIR";
  readonly schemaVersion: 2;
  readonly scopes: readonly JavaScriptSemanticScope[];
  readonly bindings: readonly JavaScriptSemanticBinding[];
  readonly callables: readonly JavaScriptSemanticCallable[];
  readonly references: readonly JavaScriptSemanticReference[];
  readonly moduleLinks: readonly JavaScriptSemanticModuleLink[];
  readonly coverage: JavaScriptSemanticCoverage;
  readonly limitations: readonly string[];
}

/** Find the innermost resolved reference at one source coordinate. */
export const semanticReferenceAt = (
  ir: JavaScriptSemanticIr,
  line: number,
  column: number,
): JavaScriptSemanticReference | undefined =>
  ir.references.find(
    ({ location }) =>
      location.start.line === line && location.start.column === column,
  );

/** Read one binding by its deterministic semantic identifier. */
export const semanticBinding = (
  ir: JavaScriptSemanticIr,
  bindingId: string,
): JavaScriptSemanticBinding | undefined =>
  ir.bindings.find(({ bindingId: candidate }) => candidate === bindingId);

/** Fail-closed result when Babel cannot produce an inert syntax tree. */
export const failedJavaScriptSemanticIr = (): JavaScriptSemanticIr => ({
  schema: "JavaScriptSemanticIR",
  schemaVersion: 2,
  scopes: [],
  bindings: [],
  callables: [],
  references: [],
  moduleLinks: [],
  coverage: { status: "failed", omittedCount: null, limitsReached: [] },
  limitations: [
    "JavaScript parsing failed; no semantic absence claim is available.",
    "No JavaScript was executed.",
  ],
});
