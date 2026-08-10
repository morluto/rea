import type { JavaScriptSourceRange } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import type {
  JavaScriptSemanticCoverage,
  JavaScriptSemanticReturnCoverage,
} from "./javascriptSemanticCoverage.js";

export type {
  JavaScriptSemanticPrimitive,
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

/** Hard bounds for one execution-free JavaScript semantic analysis. */
export interface JavaScriptSemanticLimits {
  readonly maxScopes: number;
  readonly maxBindings: number;
  readonly maxCallables: number;
  readonly maxReferences: number;
  readonly maxModuleLinks: number;
  readonly maxReturnSites: number;
  readonly maxCallSites: number;
  readonly maxCallArguments: number;
  readonly maxArgumentFlows: number;
  readonly maxCallReturnFlows: number;
  readonly maxClosureCaptures: number;
  readonly maxPromiseOperations: number;
  readonly maxEventOperations: number;
  readonly maxTimerOperations: number;
  readonly maxChildProcessOperations: number;
  readonly maxConfigurationOperations: number;
  readonly maxRequestOperations: number;
  readonly maxBoundaryOperations: number;
  readonly maxResourceOperations: number;
  readonly maxObjectOperations: number;
  readonly maxFrontiers: number;
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
  maxCallSites: 20_000,
  maxCallArguments: 100_000,
  maxArgumentFlows: 100_000,
  maxCallReturnFlows: 100_000,
  maxClosureCaptures: 100_000,
  maxPromiseOperations: 100_000,
  maxEventOperations: 100_000,
  maxTimerOperations: 100_000,
  maxChildProcessOperations: 100_000,
  maxConfigurationOperations: 100_000,
  maxRequestOperations: 100_000,
  maxBoundaryOperations: 100_000,
  maxResourceOperations: 100_000,
  maxObjectOperations: 100_000,
  maxFrontiers: 20_000,
  maxValueDepth: 16,
  maxUnionValues: 32,
  maxObjectProperties: 256,
};

/** One exact module origin followed through imports, requires, or aliases. */
export interface JavaScriptModuleOrigin {
  readonly specifier: string;
  readonly importedPath: readonly string[];
}

/** Fail-closed provenance classification for one binding. */
export type JavaScriptBindingProvenance =
  | {
      readonly status: "module";
      readonly origins: readonly [JavaScriptModuleOrigin];
      readonly reason: null;
    }
  | {
      readonly status: "local";
      readonly origins: readonly [];
      readonly reason: null;
    }
  | {
      readonly status: "ambiguous";
      readonly origins: readonly JavaScriptModuleOrigin[];
      readonly reason: string;
    }
  | {
      readonly status: "unknown" | "cycle" | "limit-reached";
      readonly origins: readonly [];
      readonly reason: string;
    };

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
  readonly returnSiteId: string;
  readonly location: JavaScriptSourceRange;
  readonly identityReferenceLocation: JavaScriptSourceRange | null;
  readonly value: JavaScriptSemanticValue;
}

/** One statically visible call or construction expression. */
export interface JavaScriptSemanticCallSite {
  readonly callSiteId: string;
  readonly kind: "call" | "construct";
  readonly callerCallableId: string | null;
  readonly location: JavaScriptSourceRange;
  readonly calleeLocation: JavaScriptSourceRange;
  readonly resolution: "exact" | "ambiguous" | "unresolved";
  readonly calleeCallableIds: readonly string[];
  readonly arguments: readonly JavaScriptSemanticCallArgument[];
}

/** One argument occurrence retained without evaluating application code. */
export interface JavaScriptSemanticCallArgument {
  readonly index: number;
  readonly location: JavaScriptSourceRange;
  readonly spread: boolean;
}

/** One positional argument that may initialize one local parameter binding. */
export interface JavaScriptSemanticArgumentFlow {
  readonly callSiteId: string;
  readonly argumentIndex: number;
  readonly argumentLocation: JavaScriptSourceRange;
  readonly callableId: string;
  readonly parameterBindingId: string;
  readonly parameterLocation: JavaScriptSourceRange;
}

/** One direct local return that may supply a call expression's value. */
export interface JavaScriptSemanticCallReturnFlow {
  readonly callSiteId: string;
  readonly callableId: string;
  readonly returnSiteId: string;
  readonly returnLocation: JavaScriptSourceRange;
}

/** One local binding initialized or assigned from a retained call expression. */
export interface JavaScriptSemanticCallResultFlow {
  readonly callSiteId: string;
  readonly bindingId: string;
  readonly definitionLocation: JavaScriptSourceRange;
}

/** One resolved outer lexical binding referenced by a nested callable. */
export interface JavaScriptSemanticClosureCapture {
  readonly callableId: string;
  readonly bindingId: string;
  readonly referenceLocation: JavaScriptSourceRange;
}

/** One bounded promise/task operation recovered from explicit syntax. */
export interface JavaScriptSemanticPromiseOperation {
  readonly promiseId: string;
  readonly kind:
    | "constructor"
    | "static"
    | "chain"
    | "aggregate"
    | "awaited-expression";
  readonly method:
    | "new"
    | "resolve"
    | "reject"
    | "then"
    | "catch"
    | "finally"
    | "all"
    | "allSettled"
    | "await";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly ownership:
    | "awaited"
    | "returned"
    | "detached"
    | "assigned"
    | "chained"
    | "aggregated"
    | "unknown";
  readonly ownerBindingId: string | null;
  readonly returnSiteId: string | null;
  readonly sourcePromiseIds: readonly string[];
  readonly sourceResolution: "complete" | "partial" | "unresolved";
}

/** Rename-resistant bounded component commitment for one callable. */
export interface JavaScriptSemanticFunctionFingerprint {
  readonly callableId: string;
  readonly status: "complete" | "partial" | "unavailable";
  readonly components: {
    readonly parameterArity: number;
    readonly normalizedAstSha256: string;
    readonly controlFlowSha256: string;
    readonly relationShapeSha256: string;
    readonly literalSetSha256: string;
    readonly effects: readonly (
      | "async"
      | "child-process"
      | "event"
      | "network"
      | "promise"
      | "resource"
      | "timer"
    )[];
  };
  readonly limitations: readonly string[];
}

/** One EventEmitter-style registration, removal, or dispatch candidate. */
export interface JavaScriptSemanticEventOperation {
  readonly eventId: string;
  readonly kind: "register" | "remove" | "dispatch";
  readonly method:
    | "on"
    | "once"
    | "addListener"
    | "prependListener"
    | "prependOnceListener"
    | "off"
    | "removeListener"
    | "removeAllListeners"
    | "emit";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly emitterKey: string;
  readonly emitterBindingId: string | null;
  readonly eventName: string | null;
  readonly listenerBindingId: string | null;
  readonly listenerLocation: JavaScriptSourceRange | null;
  readonly resolution: "complete" | "partial" | "unresolved";
}

/** One bounded timer scheduling or cancellation candidate. */
export interface JavaScriptSemanticTimerOperation {
  readonly timerId: string;
  readonly kind: "schedule" | "cancel";
  readonly method:
    | "setTimeout"
    | "setInterval"
    | "setImmediate"
    | "clearTimeout"
    | "clearInterval"
    | "clearImmediate";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly handleBindingId: string | null;
  readonly linkedTimerId: string | null;
  readonly delayMilliseconds: number | null;
  readonly resolution: "complete" | "partial" | "unresolved";
}

/** One explicit asynchronous node:child_process creation candidate. */
export interface JavaScriptSemanticChildProcessSpawn {
  readonly processId: string;
  readonly method: "spawn" | "exec" | "execFile" | "fork";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly command: string | null;
  readonly argvCount: number | null;
  readonly environmentSupplied: boolean;
  readonly stdioMode: string;
  readonly resolution: "complete" | "partial";
}

/** One exit/error listener or signal operation linked to child candidates. */
export interface JavaScriptSemanticChildProcessInteraction {
  readonly interactionId: string;
  readonly kind: "listener" | "signal";
  readonly method: "on" | "once" | "addListener" | "kill";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly processBindingId: string | null;
  readonly linkedProcessIds: readonly string[];
  readonly eventName: "exit" | "error" | null;
  readonly signalName: string | null;
  readonly listenerLocation: JavaScriptSourceRange | null;
  readonly resolution: "complete" | "partial";
}

/** One environment, argv, file, or default configuration source. */
export interface JavaScriptSemanticConfigurationOperation {
  readonly configId: string;
  readonly kind: "environment" | "argv" | "file" | "default";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly key: string | null;
  readonly sourceConfigId: string | null;
  readonly value: string | number | boolean | null;
  readonly resolution: "complete" | "partial";
}

/** One request construction or response-consumer candidate. */
export interface JavaScriptSemanticRequestOperation {
  readonly requestId: string;
  readonly kind: "request" | "response-consumer";
  readonly method:
    | "fetch"
    | "WebSocket"
    | "request"
    | "get"
    | "json"
    | "text"
    | "arrayBuffer";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly linkedRequestIds: readonly string[];
  readonly endpoint: string | null;
  readonly fields: readonly {
    readonly name: string;
    readonly sourceBindingId: string | null;
  }[];
  readonly resolution: "complete" | "partial" | "unresolved";
}

/** One parse, coercion, or validation boundary candidate. */
export interface JavaScriptSemanticBoundaryOperation {
  readonly boundaryId: string;
  readonly kind: "parse" | "coerce" | "validate";
  readonly method: string;
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly sourceBindingId: string | null;
  readonly resultBindingId: string | null;
  readonly resolution: "complete" | "partial";
}

/** One explicit built-in resource acquisition or release candidate. */
export interface JavaScriptSemanticResourceOperation {
  readonly resourceId: string;
  readonly kind: "acquire" | "release";
  readonly method:
    | "open"
    | "openSync"
    | "createReadStream"
    | "createWriteStream"
    | "connect"
    | "createConnection"
    | "close"
    | "destroy"
    | "end";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly linkedResourceIds: readonly string[];
  readonly resolution: "complete" | "partial";
}

/** One static property read/write, spread, or destructuring candidate. */
export interface JavaScriptSemanticObjectOperation {
  readonly objectOperationId: string;
  readonly kind: "read" | "write" | "spread" | "destructure";
  readonly location: JavaScriptSourceRange;
  readonly ownerCallableId: string | null;
  readonly objectBindingId: string | null;
  readonly targetBindingId: string | null;
  readonly propertyName: string | null;
  readonly resolution: "complete" | "partial";
}

/** One syntax location where exact local semantic continuation is unavailable. */
export interface JavaScriptSemanticFrontier {
  readonly kind: "dynamic-call" | "dynamic-property";
  readonly callableId: string | null;
  readonly location: JavaScriptSourceRange;
  readonly reason: string;
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

/** Provider-neutral JavaScript semantic IR v4. */
export interface JavaScriptSemanticIr {
  readonly schema: "JavaScriptSemanticIR";
  readonly schemaVersion: 4;
  readonly scopes: readonly JavaScriptSemanticScope[];
  readonly bindings: readonly JavaScriptSemanticBinding[];
  readonly callables: readonly JavaScriptSemanticCallable[];
  readonly references: readonly JavaScriptSemanticReference[];
  readonly moduleLinks: readonly JavaScriptSemanticModuleLink[];
  readonly callSites: readonly JavaScriptSemanticCallSite[];
  readonly argumentFlows: readonly JavaScriptSemanticArgumentFlow[];
  readonly callReturnFlows: readonly JavaScriptSemanticCallReturnFlow[];
  readonly callResultFlows: readonly JavaScriptSemanticCallResultFlow[];
  readonly closureCaptures: readonly JavaScriptSemanticClosureCapture[];
  readonly promiseOperations: readonly JavaScriptSemanticPromiseOperation[];
  readonly eventOperations: readonly JavaScriptSemanticEventOperation[];
  readonly timerOperations: readonly JavaScriptSemanticTimerOperation[];
  readonly childProcessSpawns: readonly JavaScriptSemanticChildProcessSpawn[];
  readonly childProcessInteractions: readonly JavaScriptSemanticChildProcessInteraction[];
  readonly configurationOperations: readonly JavaScriptSemanticConfigurationOperation[];
  readonly requestOperations: readonly JavaScriptSemanticRequestOperation[];
  readonly boundaryOperations: readonly JavaScriptSemanticBoundaryOperation[];
  readonly resourceOperations: readonly JavaScriptSemanticResourceOperation[];
  readonly objectOperations: readonly JavaScriptSemanticObjectOperation[];
  readonly functionFingerprints: readonly JavaScriptSemanticFunctionFingerprint[];
  readonly frontiers: readonly JavaScriptSemanticFrontier[];
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
  schemaVersion: 4,
  scopes: [],
  bindings: [],
  callables: [],
  references: [],
  moduleLinks: [],
  callSites: [],
  argumentFlows: [],
  callReturnFlows: [],
  callResultFlows: [],
  closureCaptures: [],
  promiseOperations: [],
  eventOperations: [],
  timerOperations: [],
  childProcessSpawns: [],
  childProcessInteractions: [],
  configurationOperations: [],
  requestOperations: [],
  boundaryOperations: [],
  resourceOperations: [],
  objectOperations: [],
  functionFingerprints: [],
  frontiers: [],
  coverage: { status: "failed", omittedCount: null, limitsReached: [] },
  limitations: [
    "JavaScript parsing failed; no semantic absence claim is available.",
    "No JavaScript was executed.",
  ],
});
