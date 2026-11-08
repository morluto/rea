import { createXhrOpenRequestQuery } from "./javascriptNetworkRequests.js";
import { uniqueSortedBy } from "../canonicalOrdering.js";
import * as t from "@babel/types";
import { JavaScriptRouteScan } from "./javascriptRouteScan.js";
import type { JavaScriptRouteSourceFacts } from "./javascriptRouteFacts.js";
import { RETURNED_REFERENCE_WIDENING_LIMITATION } from "./javascriptSemanticCoverage.js";
import { collectElectronWrappedCallPathsSteps } from "./electronWrappedCallPaths.js";
import {
  ELECTRON_IDENTITY_LIMITATION,
  ELECTRON_MODULE,
  ELECTRON_REFERENCE_KINDS,
} from "./javascriptElectronMemberWrites.js";

import {
  completeSemanticSteps,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

import {
  isElectronRendererLoad,
  resolveElectronBrowserWindowReceiver,
} from "./electronStaticRenderer.js";
import { finishElectronNativeBindingsSteps } from "./electronStaticAnalysisNative.js";
import { inspectElectronStaticNode } from "./electronStaticAnalysis.js";
import {
  hasPossibleCommonJsDelegateWrite,
  semanticFactoryLoaderMemberAt,
} from "./javascriptSemanticRequireOrigin.js";
import { semanticResourceLimitReason } from "./javascriptSemanticResourceLimits.js";
import { createStaticPathIntrinsicQuery } from "./javascriptStaticPathIntrinsics.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import { finishElectronBrowserWindowsSteps } from "./electronStaticAnalysisBrowser.js";
import {
  detectVendors,
  failedJavaScriptStaticAnalysis,
  registrationKey,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  addReference,
  addEndpoint,
  addSourceMapDirectives,
  finishPartialNetworkEndpoints,
  finishModuleRequireCalls,
  finishSqliteStorageCalls,
  inspectCall,
  inspectRpcNode,
  finishRpcScanSteps,
} from "./javascriptStaticAnalysisCalls.js";
import {
  finishBundlerExports,
  inspectBundlerRegistration,
  inspectBundlerBootstrap,
  inspectEsbuildWrapper,
} from "./javascriptStaticAnalysisBundler.js";
import {
  finalizeLocatedFindings,
  finalizeLocatedFindingsSteps,
} from "./javascriptStaticAnalysisFindings.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  type JavaScriptFindingContext,
} from "./javascriptStaticAnalysisState.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  indexJavaScriptElectronIdentitySteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

import { createJavaScriptRpcScan } from "./javascriptRpcEndpoints.js";
import { classifyParsedJavaScriptViteDependencySpecifiersSteps } from "./javascriptViteDependencies.js";
import {
  hasUncertainTypeOnlyModuleSideEffect,
  semanticStaticModuleSource,
  semanticImportEqualsSpecifier,
} from "./javascriptModuleDeclaration.js";
import {
  javaScriptStaticParseStatus,
  type JavaScriptStaticCoverage,
} from "./javascriptStaticCoverage.js";

/** Parse one JavaScript artifact and recover static structure only. */
export const analyzeJavaScriptStaticSource = (
  source: string,
): JavaScriptStaticAnalysis => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptStaticAnalysis()
    : analyzeParsedJavaScriptStaticSource(source, file);
};

/** Recover static structure from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptStaticSource = (
  source: string,
  file: ParsedJavaScriptSource,
): JavaScriptStaticAnalysis =>
  completeSemanticSteps(analyzeParsedJavaScriptStaticSourceSteps(source, file));

/** Static analysis that yields during its source traversal; results are unchanged. */
export function* analyzeParsedJavaScriptStaticSourceSteps(
  source: string,
  file: ParsedJavaScriptSource,
): Generator<void, JavaScriptStaticAnalysis> {
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  // One definitions pass serves receiver classification and binding lookup.
  const index = yield* indexJavaScriptBindingsWithReceiversSteps(file.program);
  const { bindings, receivers } = index;
  yield* index.indexAmbientWritesSteps();
  if (hasPossibleCommonJsDelegateWrite(bindings))
    yield* index.indexMemberMutationFactsSteps();
  const electronIdentity = yield* indexJavaScriptElectronIdentitySteps(
    file.program,
    bindings,
  );
  const viteDependencySpecifiers =
    yield* classifyParsedJavaScriptViteDependencySpecifiersSteps(
      file,
      bindings,
    );
  const findings: JavaScriptFindingContext = {
    xhrOpenRequest: createXhrOpenRequestQuery(index),
    pathIntrinsics: createStaticPathIntrinsicQuery(index),
    browserWindowReceiver: (node, site, suffix) =>
      resolveElectronBrowserWindowReceiver(node, site, suffix, findings, index),
    rendererLoad: (callee, site) =>
      isElectronRendererLoad(callee, site, findings, index),
    source,
    accumulator,
    openReceiverFacts: receivers.openReceivers,
    electronBindings: electronIdentity.bindings,
    electronExportIntact: electronIdentity.intactExport,
    electronInvocationPath: electronIdentity.invocationPath,
    electronAppPathChangePossible: electronIdentity.mayChangeAppPath,
    rpcScan: createJavaScriptRpcScan(source, receivers.rpcClientRoots, index),
    expressionShapes: createSemanticExpressionShapeResolver(bindings),
  };
  const routeScan = yield* JavaScriptRouteScan.createSteps(
    file,
    index,
    (fact) => addEndpoint(findings, { ...fact, kind: "route" }),
  );
  const viteReferencePositions = yield* traverseStaticSourceSteps(
    file,
    findings,
    bindings,
    viteDependencySpecifiers,
    routeScan,
  );
  yield* retainViteReferencesSteps(
    findings,
    viteDependencySpecifiers,
    viteReferencePositions,
  );
  const routes = yield* routeScan.finishSteps();
  if (accumulator.bundlerExportHelpersObserved)
    yield* index.indexMemberMutationFactsSteps();
  finishBundlerExports(accumulator, index);
  yield* finishElectronNativeBindingsSteps(findings, index);
  yield* finishElectronBrowserWindowsSteps(findings, index);
  if (accumulator.pendingModuleRequireCalls.length > 0) {
    yield* index.indexMemberMutationFactsSteps();
    finishModuleRequireCalls(findings, index);
  }
  if (
    accumulator.pendingNetworkCalls.length > 0 ||
    accumulator.pendingSqliteCalls.length > 0
  ) {
    yield* index.indexMemberMutationFactsSteps();
    finishPartialNetworkEndpoints(findings, bindings, index);
    finishSqliteStorageCalls(findings, bindings, index);
  }
  accumulator.electronCallPaths = yield* collectElectronWrappedCallPathsSteps(
    file.program,
    bindings,
    source,
    accumulator,
    electronIdentity,
  );
  addSourceMapDirectives(source, file.comments ?? [], accumulator);
  const references = yield* finalizeLocatedFindingsSteps(
    accumulator.references,
    accumulator.moduleRangeIndex,
  );
  let hasElectronReference = false;
  for (const [
    index,
    { kind, loader, operation, specifier },
  ] of references.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (
      ELECTRON_REFERENCE_KINDS.has(kind) &&
      operation === "load" &&
      // a factory-loader reference names a module inside the artifact.
      loader !== "factory-loader" &&
      specifier !== null &&
      ELECTRON_MODULE.test(specifier)
    ) {
      hasElectronReference = true;
      break;
    }
  }
  return finalizeStaticAnalysis(source, file, accumulator, bindings, routes, {
    references,
    hasElectronReference,
  });
}

function* traverseStaticSourceSteps(
  file: ParsedJavaScriptSource,
  findings: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  viteCalls: ReadonlyMap<
    t.CallExpression | t.OptionalCallExpression,
    readonly (string | undefined)[]
  >,
  routeScan: JavaScriptRouteScan,
): Generator<
  void,
  ReadonlyMap<t.CallExpression | t.OptionalCallExpression, number>
> {
  const positions = new Map<
    t.CallExpression | t.OptionalCallExpression,
    number
  >();
  yield* traverseJavaScriptAstSteps(file, {
    // Code that never runs under the bundler convention yields no findings.
    skip: (node) => findings.accumulator.unusedFactoryDefaults.has(node),
    enter: (node, parent) => {
      findings.accumulator.visitedNodes += 1;
      routeScan.inspect(node, parent);
      if (!bindings.erasedSyntaxNodes.has(node)) {
        inspectNode(node, findings, bindings);
        if (
          (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
          viteCalls.has(node)
        )
          positions.set(node, findings.accumulator.references.length);
      }
      return undefined;
    },
  });
  yield* finishRpcScanSteps(findings);
  return positions;
}

/** merge normalized Vite values in batches without changing discovery order. */
function* retainViteReferencesSteps(
  findings: JavaScriptFindingContext,
  calls: ReadonlyMap<
    t.CallExpression | t.OptionalCallExpression,
    readonly (string | undefined)[]
  >,
  positions: ReadonlyMap<t.CallExpression | t.OptionalCallExpression, number>,
): Generator<void> {
  if (calls.size === 0) return;
  const { accumulator } = findings;
  const genericCount = accumulator.references.length;
  const ordered: typeof accumulator.references = [];
  let genericIndex = 0;
  let examined = 0;
  for (const [node, specifiers] of calls) {
    const position = positions.get(node);
    if (examined++ % 1024 === 0) yield;
    if (position === undefined) continue;
    while (genericIndex < position) {
      if (examined++ % 1024 === 0) yield;
      const reference = accumulator.references[genericIndex++];
      if (reference !== undefined) ordered.push(reference);
    }
    for (const specifier of specifiers) {
      if (examined++ % 1024 === 0) yield;
      const before = accumulator.references.length;
      // A table value is an observed candidate, not proof of a runtime load.
      accumulator.unknownFindings += 1;
      addReference(findings, {
        node,
        kind: "vite-table-candidate",
        operation: "candidate",
        specifier,
      });
      const reference = accumulator.references[before];
      if (reference !== undefined) ordered.push(reference);
    }
  }
  while (genericIndex < genericCount) {
    if (examined++ % 1024 === 0) yield;
    const reference = accumulator.references[genericIndex++];
    if (reference !== undefined) ordered.push(reference);
  }
  for (const [index, reference] of ordered.entries()) {
    if (index % 1024 === 0) yield;
    accumulator.references[index] = reference;
  }
  accumulator.references.length = ordered.length;
}

const finalizeStaticAnalysis = (
  source: string,
  file: ParsedJavaScriptSource,
  accumulator: AnalysisAccumulator,
  bindings: JavaScriptSemanticAnalysisState,
  routes: JavaScriptRouteSourceFacts,
  referenceFacts: {
    readonly references: JavaScriptStaticAnalysis["references"];
    readonly hasElectronReference: boolean;
  },
): JavaScriptStaticAnalysis => {
  const { references, hasElectronReference } = referenceFacts;
  const parserErrors = file.errors.length;
  const typeOnlySideEffect = hasUncertainTypeOnlyModuleSideEffect(file.program);
  const resourceLimits = [...bindings.valueResourceLimits].sort();
  const coverage: JavaScriptStaticCoverage = {
    syntax:
      parserErrors === 0
        ? { status: "complete", error_count: 0 }
        : { status: "recovered", error_count: parserErrors },
    semantics: {
      unknown_findings: accumulator.unknownFindings,
      uncertainty: [
        ...(accumulator.unknownFindings > 0
          ? ["dynamic-findings" as const]
          : []),
        ...(bindings.returnedReferenceWidenings.size > 0
          ? ["returned-reference-widening" as const]
          : []),
        ...(typeOnlySideEffect
          ? ["type-only-module-side-effect" as const]
          : []),
      ],
    },
    examination: {
      status:
        resourceLimits.length > 0 ||
        accumulator.electronCallPathLimitReached === true
          ? "limited"
          : "complete",
      semantic_resource_limits: resourceLimits,
      electron_call_paths_limited:
        accumulator.electronCallPathLimitReached === true,
    },
    applicability: { electron: hasElectronReference ? "observed" : "unknown" },
  };
  const limitations = [
    ...(bindings.valueResourceLimits.has("alias-selections")
      ? [semanticResourceLimitReason("alias-selections")]
      : []),
    ...(bindings.returnedReferenceWidenings.size > 0
      ? [RETURNED_REFERENCE_WIDENING_LIMITATION]
      : []),
    ...(accumulator.electronCallPaths?.length
      ? [
          "Bundled Electron call paths use static argument and closure substitutions. Conditions, ambient helper overrides, runtime reachability and arbitrary side effects remain unproven.",
        ]
      : []),
    ...(accumulator.electronCallPathLimitReached
      ? [
          "Electron wrapper expansion reached its resource budget (1000000 visits/substitutions or depth 128); additional paths remain unknown.",
        ]
      : []),
    ...(parserErrors === 0
      ? []
      : [
          "The parser recovered from syntax errors; affected facts are partial.",
        ]),
    ...(accumulator.unknownFindings === 0
      ? []
      : [
          "One or more static keys, expressions, or Electron boundary values were dynamic and remain unknown.",
        ]),
    ...(typeOnlySideEffect
      ? [
          "Compiler options are unavailable; inline type-only imports or re-exports may preserve a module side-effect dependency.",
        ]
      : []),
    ...(hasElectronReference ? [ELECTRON_IDENTITY_LIMITATION] : []),
    "JavaScript syntax was parsed as data and was never evaluated.",
  ];
  return {
    parse_status: javaScriptStaticParseStatus(coverage),
    analysis_coverage: coverage,
    parse_error_count: parserErrors,
    visited_ast_nodes: accumulator.visitedNodes,
    references,
    endpoints: finalizeLocatedFindings(
      accumulator.endpoints,
      accumulator.moduleRangeIndex,
    ),
    routes,
    storage: finalizeLocatedFindings(
      accumulator.storage,
      accumulator.moduleRangeIndex,
    ),
    bundler_registrations: uniqueSortedBy(
      accumulator.registrations,
      registrationKey,
    ),
    role_paths: finalizeLocatedFindings(
      accumulator.roles,
      accumulator.moduleRangeIndex,
    ),
    source_map_urls: accumulator.sourceMaps,
    vendors: detectVendors(source),
    electron: {
      ...(accumulator.appPathChanges.length > 0
        ? {
            app_path_changes: finalizeLocatedFindings(
              accumulator.appPathChanges,
              accumulator.moduleRangeIndex,
            ),
          }
        : {}),
      ...(accumulator.electronCallPaths?.length
        ? { call_paths: accumulator.electronCallPaths }
        : {}),
      browser_windows: finalizeLocatedFindings(
        accumulator.browserWindows,
        accumulator.moduleRangeIndex,
      ),
      context_bridge_apis: finalizeLocatedFindings(
        accumulator.contextBridgeApis,
        accumulator.moduleRangeIndex,
      ),
      ipc: finalizeLocatedFindings(
        accumulator.ipc,
        accumulator.moduleRangeIndex,
      ),
      sender_validations: finalizeLocatedFindings(
        accumulator.senderValidations,
        accumulator.moduleRangeIndex,
      ),
      utility_processes: finalizeLocatedFindings(
        accumulator.utilityProcesses,
        accumulator.moduleRangeIndex,
      ),
      native_addon_bindings: finalizeLocatedFindings(
        accumulator.nativeAddonBindings,
        accumulator.moduleRangeIndex,
      ),
      protocols: finalizeLocatedFindings(
        accumulator.protocols,
        accumulator.moduleRangeIndex,
      ),
    },
    limitations,
  };
};

const inspectNode = (
  node: t.Node,
  findings: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { source, accumulator } = findings;
  inspectElectronStaticNode(node, findings);
  if (t.isCallExpression(node)) {
    inspectBundlerBootstrap(source, node, accumulator, bindings);
    inspectBundlerRegistration(source, node, accumulator, bindings);
    inspectEsbuildWrapper(source, node, accumulator, bindings);
    if (
      semanticFactoryLoaderMemberAt(
        node,
        bindings,
        accumulator.factoryRequireBindingIds,
        "d",
      ) === "factory-loader"
    )
      accumulator.bundlerExportHelpersObserved = true;
    inspectCall(node, findings, bindings);
  } else if (t.isOptionalCallExpression(node)) {
    inspectCall(node, findings, bindings);
  } else if (t.isNewExpression(node)) inspectCall(node, findings, bindings);
  if (t.isTSImportEqualsDeclaration(node)) {
    const specifier = semanticImportEqualsSpecifier(node);
    if (specifier !== null)
      addReference(findings, { node, kind: "require", specifier });
  } else {
    const moduleSource = semanticStaticModuleSource(node);
    if (moduleSource !== null)
      addReference(findings, {
        node,
        kind: "static-import",
        specifier: moduleSource.value,
      });
  }
  if (t.isImportExpression(node))
    addReference(findings, {
      node,
      kind: "dynamic-import",
      specifier: stringValue(node.source),
    });
  inspectRpcNode(node, findings);
};
