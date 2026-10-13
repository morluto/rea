import * as t from "@babel/types";
import { collectElectronWrappedCallPaths } from "./electronWrappedCallPaths.js";
import {
  ELECTRON_IDENTITY_LIMITATION,
  ELECTRON_MODULE,
} from "./javascriptElectronMemberWrites.js";

import {
  completeSemanticSteps,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

import { inspectElectronStaticNode } from "./electronStaticAnalysis.js";
import {
  detectVendors,
  failedJavaScriptStaticAnalysis,
  registrationKey,
  sortedUnique,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  addReference,
  addSourceMapDirectives,
  inspectCall,
  inspectRouteProperty,
  inspectRoleProperty,
  inspectRpcNode,
} from "./javascriptStaticAnalysisCalls.js";
import {
  inspectBundlerRegistration,
  inspectBundlerBootstrap,
  inspectEsbuildWrapper,
} from "./javascriptStaticAnalysisBundler.js";
import { finalizeLocatedFindings } from "./javascriptStaticAnalysisFindings.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  type JavaScriptFindingContext,
} from "./javascriptStaticAnalysisState.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  indexJavaScriptElectronIdentitySteps,
  indexJavaScriptBindingsSteps,
  classifyParsedJavaScriptRpcClientRootsSteps,
  classifyParsedJavaScriptOpenReceivers,
  type JavaScriptOpenReceiverFact,
} from "./javascriptSemanticAnalysis.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

import { createJavaScriptRpcScan } from "./javascriptRpcEndpoints.js";
import { semanticImportEqualsSpecifier } from "./javascriptSemanticProjection.js";
import {
  hasUncertainTypeOnlyModuleSideEffect,
  isTypeOnlyExportDeclaration,
  isTypeOnlyImportDeclaration,
} from "./javascriptModuleDeclaration.js";

/** Parse one JavaScript artifact and recover static structure only. */
export const analyzeJavaScriptStaticSource = (
  source: string,
): JavaScriptStaticAnalysis => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptStaticAnalysis()
    : analyzeParsedJavaScriptStaticSource(
        source,
        file,
        classifyParsedJavaScriptOpenReceivers(file),
      );
};

/** Recover static structure from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptStaticSource = (
  source: string,
  file: ParsedJavaScriptSource,
  openReceiverFacts?: ReadonlyMap<number, JavaScriptOpenReceiverFact>,
): JavaScriptStaticAnalysis =>
  completeSemanticSteps(
    analyzeParsedJavaScriptStaticSourceSteps(source, file, openReceiverFacts),
  );

/** Static analysis that yields during its source traversal; results are unchanged. */
export function* analyzeParsedJavaScriptStaticSourceSteps(
  source: string,
  file: ParsedJavaScriptSource,
  openReceiverFacts?: ReadonlyMap<number, JavaScriptOpenReceiverFact>,
): Generator<void, JavaScriptStaticAnalysis> {
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  const bindings = yield* indexJavaScriptBindingsSteps(file.program);
  const electronIdentity = yield* indexJavaScriptElectronIdentitySteps(
    file.program,
    bindings,
  );
  const clientRoots = yield* classifyParsedJavaScriptRpcClientRootsSteps(file);
  yield* traverseStaticSourceSteps(
    file,
    {
      source,
      accumulator,
      ...(openReceiverFacts === undefined ? {} : { openReceiverFacts }),
      electronBindings: electronIdentity.bindings,
      rpcScan: createJavaScriptRpcScan(source, clientRoots),
    },
    bindings,
  );
  accumulator.electronCallPaths = collectElectronWrappedCallPaths(
    file.program,
    bindings,
    source,
    accumulator,
    electronIdentity,
  );
  addSourceMapDirectives(source, file.comments ?? [], accumulator);
  return finalizeStaticAnalysis(source, file, accumulator);
}

function* traverseStaticSourceSteps(
  file: ParsedJavaScriptSource,
  findings: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  yield* traverseJavaScriptAstSteps(file, {
    enter: (node) => {
      findings.accumulator.visitedNodes += 1;
      inspectNode(node, findings, bindings);
      return undefined;
    },
  });
}

const finalizeStaticAnalysis = (
  source: string,
  file: ParsedJavaScriptSource,
  accumulator: AnalysisAccumulator,
): JavaScriptStaticAnalysis => {
  const parserErrors = file.errors.length;
  const limitations = [
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
    ...(hasUncertainTypeOnlyModuleSideEffect(file.program)
      ? [
          "Compiler options are unavailable; inline type-only imports or re-exports may preserve a module side-effect dependency.",
        ]
      : []),
    ...(accumulator.references.some(
      ({ value }) =>
        value.specifier !== null && ELECTRON_MODULE.test(value.specifier),
    )
      ? [ELECTRON_IDENTITY_LIMITATION]
      : []),
    "JavaScript syntax was parsed as data and was never evaluated.",
  ];
  return {
    parse_status:
      parserErrors > 0 || accumulator.unknownFindings > 0
        ? "partial"
        : "complete",
    parse_error_count: parserErrors,
    visited_ast_nodes: accumulator.visitedNodes,
    references: finalizeLocatedFindings(
      accumulator.references,
      accumulator.moduleRangeIndex,
    ),
    endpoints: finalizeLocatedFindings(
      accumulator.endpoints,
      accumulator.moduleRangeIndex,
    ),
    storage: finalizeLocatedFindings(
      accumulator.storage,
      accumulator.moduleRangeIndex,
    ),
    bundler_registrations: sortedUnique(
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
    inspectCall(source, node, findings, bindings);
  } else if (t.isOptionalCallExpression(node)) {
    inspectCall(source, node, findings, bindings);
  } else if (t.isNewExpression(node))
    inspectCall(source, node, findings, bindings);
  if (t.isTSImportEqualsDeclaration(node)) {
    const specifier = semanticImportEqualsSpecifier(node);
    if (specifier !== null)
      addReference(findings, { node, kind: "require", specifier });
  } else if (
    (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) &&
    node.source !== undefined &&
    !(t.isImportDeclaration(node) && isTypeOnlyImportDeclaration(node)) &&
    !(t.isExportAllDeclaration(node) && isTypeOnlyExportDeclaration(node))
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (
    t.isExportNamedDeclaration(node) &&
    node.source != null &&
    !isTypeOnlyExportDeclaration(node)
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (t.isImportExpression(node))
    addReference(findings, {
      node,
      kind: "dynamic-import",
      specifier: stringValue(node.source),
    });
  if (t.isObjectProperty(node)) {
    inspectRouteProperty(node, findings);
    inspectRoleProperty(node, findings);
  }
  inspectRpcNode(node, findings);
};
