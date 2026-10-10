import * as t from "@babel/types";

import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

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
} from "./javascriptStaticAnalysisCalls.js";
import {
  inspectBundlerRegistration,
  inspectEsbuildWrapper,
} from "./javascriptStaticAnalysisBundler.js";
import { finalizeLocatedFindings } from "./javascriptStaticAnalysisFindings.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  type JavaScriptFindingContext,
} from "./javascriptStaticAnalysisState.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import {
  classifyParsedJavaScriptElectronBindings,
  classifyParsedJavaScriptOpenReceivers,
  type JavaScriptOpenReceiverFact,
} from "./javascriptSemanticAnalysis.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

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
): JavaScriptStaticAnalysis => {
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  traverseStaticSource(file, {
    source,
    accumulator,
    ...(openReceiverFacts === undefined ? {} : { openReceiverFacts }),
    electronBindings: classifyParsedJavaScriptElectronBindings(file),
  });
  addSourceMapDirectives(source, file.comments ?? [], accumulator);
  return finalizeStaticAnalysis(source, file, accumulator);
};

const traverseStaticSource = (
  file: ParsedJavaScriptSource,
  findings: JavaScriptFindingContext,
): void => {
  traverseJavaScriptAst(file, {
    enter: (node) => {
      findings.accumulator.visitedNodes += 1;
      inspectNode(node, findings);
      return undefined;
    },
  });
};

const finalizeStaticAnalysis = (
  source: string,
  file: ParsedJavaScriptSource,
  accumulator: AnalysisAccumulator,
): JavaScriptStaticAnalysis => {
  const parserErrors = file.errors.length;
  const limitations = [
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
): void => {
  const { source, accumulator } = findings;
  inspectElectronStaticNode(node, findings);
  if (t.isCallExpression(node)) {
    inspectBundlerRegistration(source, node, accumulator);
    inspectEsbuildWrapper(source, node, accumulator);
    inspectCall(source, node, findings);
  } else if (t.isOptionalCallExpression(node)) {
    inspectCall(source, node, findings);
  } else if (t.isNewExpression(node)) inspectCall(source, node, findings);
  if (
    (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) &&
    node.source !== undefined
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (t.isExportNamedDeclaration(node) && node.source != null)
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
};
