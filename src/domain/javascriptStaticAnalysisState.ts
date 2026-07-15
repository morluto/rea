import type * as t from "@babel/types";

import type {
  JavaScriptBundlerRegistration,
  JavaScriptRolePath,
  JavaScriptStaticAnalysis,
  JavaScriptStaticEndpoint,
  JavaScriptStaticReference,
  JavaScriptStaticStorage,
} from "./javascriptStaticAnalysisTypes.js";
import type {
  ElectronBrowserWindowFinding,
  ElectronContextBridgeFinding,
  ElectronIpcFinding,
  ElectronNativeAddonBindingFinding,
  ElectronSenderValidationFinding,
  ElectronUtilityProcessFinding,
} from "./electronStaticAnalysisTypes.js";

/** Source offsets for one recovered bundle module factory. */
export interface JavaScriptModuleRange {
  readonly start: number;
  readonly end: number;
  readonly key: string;
  readonly requireName: string | null;
}

/** Static finding retained with its source offset until module attribution. */
export interface LocatedJavaScriptFinding<Value> {
  readonly offset: number;
  readonly value: Value;
}

/** Mutable bounded collections used during one inert AST traversal. */
export interface JavaScriptAnalysisAccumulator {
  readonly references: LocatedJavaScriptFinding<JavaScriptStaticReference>[];
  readonly endpoints: LocatedJavaScriptFinding<JavaScriptStaticEndpoint>[];
  readonly storage: LocatedJavaScriptFinding<JavaScriptStaticStorage>[];
  readonly roles: LocatedJavaScriptFinding<JavaScriptRolePath>[];
  readonly sourceMaps: JavaScriptStaticAnalysis["source_map_urls"][number][];
  readonly registrations: JavaScriptBundlerRegistration[];
  readonly browserWindows: LocatedJavaScriptFinding<ElectronBrowserWindowFinding>[];
  readonly contextBridgeApis: LocatedJavaScriptFinding<ElectronContextBridgeFinding>[];
  readonly ipc: LocatedJavaScriptFinding<ElectronIpcFinding>[];
  readonly senderValidations: LocatedJavaScriptFinding<ElectronSenderValidationFinding>[];
  readonly utilityProcesses: LocatedJavaScriptFinding<ElectronUtilityProcessFinding>[];
  readonly nativeAddonBindings: LocatedJavaScriptFinding<ElectronNativeAddonBindingFinding>[];
  readonly modules: JavaScriptModuleRange[];
  readonly seen: Set<string>;
  visitedNodes: number;
  droppedFindings: number;
  moduleCount: number;
  unknownFindings: number;
  structuralTruncation: boolean;
  truncated: boolean;
}

/** Shared source, accumulator, and finding bound for helper inspections. */
export interface JavaScriptFindingContext {
  readonly source: string;
  readonly accumulator: JavaScriptAnalysisAccumulator;
  readonly maximum: number;
}

/** Candidate import, require, worker, or service-worker reference. */
export interface JavaScriptReferenceInput {
  readonly node: t.Node;
  readonly kind: JavaScriptStaticReference["kind"];
  readonly specifier: string | undefined;
}

/** Candidate route or network endpoint literal. */
export interface JavaScriptEndpointInput {
  readonly node: t.Node;
  readonly kind: JavaScriptStaticEndpoint["kind"];
  readonly value: string;
  readonly mechanism: string;
}

/** Values required to append one module-attributable static finding. */
export interface LocatedJavaScriptFindingInput<
  Value extends { readonly module_key: string | null },
> {
  readonly collection: LocatedJavaScriptFinding<Value>[];
  readonly key: string;
  readonly node: t.Node;
  readonly value: Value;
}

/** Create isolated mutable state for one bounded source analysis. */
export const createJavaScriptAnalysisAccumulator =
  (): JavaScriptAnalysisAccumulator => ({
    references: [],
    endpoints: [],
    storage: [],
    roles: [],
    sourceMaps: [],
    registrations: [],
    browserWindows: [],
    contextBridgeApis: [],
    ipc: [],
    senderValidations: [],
    utilityProcesses: [],
    nativeAddonBindings: [],
    modules: [],
    seen: new Set(),
    visitedNodes: 0,
    droppedFindings: 0,
    moduleCount: 0,
    unknownFindings: 0,
    structuralTruncation: false,
    truncated: false,
  });
