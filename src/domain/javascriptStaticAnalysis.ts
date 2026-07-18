import { parse } from "@babel/parser";
import * as t from "@babel/types";

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
import { inspectBundlerRegistration } from "./javascriptStaticAnalysisBundler.js";
import { finalizeLocatedFindings } from "./javascriptStaticAnalysisFindings.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
} from "./javascriptStaticAnalysisState.js";
import type {
  JavaScriptStaticAnalysis,
  JavaScriptStaticAnalysisLimits,
} from "./javascriptStaticAnalysisTypes.js";

/** Parse one bounded JavaScript artifact and recover static structure only. */
export const analyzeJavaScriptStaticSource = (
  source: string,
  limits: JavaScriptStaticAnalysisLimits,
): JavaScriptStaticAnalysis => {
  let file: ReturnType<typeof parse>;
  try {
    file = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return failedJavaScriptStaticAnalysis();
  }
  const accumulator = createJavaScriptAnalysisAccumulator();
  traverseStaticSource(source, file, accumulator, limits);
  addSourceMapDirectives(source, accumulator, limits.maxFindings);
  return finalizeStaticAnalysis(source, file, accumulator, limits);
};

const traverseStaticSource = (
  source: string,
  file: ReturnType<typeof parse>,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): void => {
  if (limits.now() > limits.deadline) accumulator.truncated = true;
  if (!accumulator.truncated)
    t.traverseFast(file, (node) => {
      accumulator.visitedNodes += 1;
      if (
        accumulator.visitedNodes > limits.maxAstNodes ||
        (accumulator.visitedNodes % 1_024 === 0 &&
          limits.now() > limits.deadline)
      ) {
        accumulator.truncated = true;
        return t.traverseFast.stop;
      }
      inspectNode(source, node, accumulator, limits);
      return undefined;
    });
};

const finalizeStaticAnalysis = (
  source: string,
  file: ReturnType<typeof parse>,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): JavaScriptStaticAnalysis => {
  const parserErrors = file.errors.length;
  const limitations = [
    ...(parserErrors === 0
      ? []
      : [
          "The parser recovered from syntax errors; affected facts are partial.",
        ]),
    ...(accumulator.truncated
      ? ["AST analysis stopped at the configured node or time bound."]
      : []),
    ...(accumulator.droppedFindings === 0
      ? []
      : ["Static findings were truncated at the configured finding bound."]),
    ...(accumulator.structuralTruncation
      ? ["Bundler metadata reached a per-record structural bound."]
      : []),
    ...(accumulator.unknownFindings === 0
      ? []
      : [
          "One or more static keys, expressions, or Electron boundary values were dynamic and remain unknown.",
        ]),
    "JavaScript syntax was parsed as data and was never evaluated.",
  ];
  return {
    parse_status:
      accumulator.truncated || accumulator.droppedFindings > 0
        ? "truncated"
        : parserErrors > 0 || accumulator.unknownFindings > 0
          ? "partial"
          : "complete",
    parse_error_count: parserErrors,
    visited_ast_nodes: Math.min(accumulator.visitedNodes, limits.maxAstNodes),
    dropped_findings: accumulator.droppedFindings,
    references: finalizeLocatedFindings(
      accumulator.references,
      accumulator.modules,
    ),
    endpoints: finalizeLocatedFindings(
      accumulator.endpoints,
      accumulator.modules,
    ),
    storage: finalizeLocatedFindings(accumulator.storage, accumulator.modules),
    bundler_registrations: sortedUnique(
      accumulator.registrations,
      registrationKey,
    ),
    role_paths: finalizeLocatedFindings(accumulator.roles, accumulator.modules),
    source_map_urls: accumulator.sourceMaps,
    vendors: detectVendors(source),
    electron: {
      browser_windows: finalizeLocatedFindings(
        accumulator.browserWindows,
        accumulator.modules,
      ),
      context_bridge_apis: finalizeLocatedFindings(
        accumulator.contextBridgeApis,
        accumulator.modules,
      ),
      ipc: finalizeLocatedFindings(accumulator.ipc, accumulator.modules),
      sender_validations: finalizeLocatedFindings(
        accumulator.senderValidations,
        accumulator.modules,
      ),
      utility_processes: finalizeLocatedFindings(
        accumulator.utilityProcesses,
        accumulator.modules,
      ),
      native_addon_bindings: finalizeLocatedFindings(
        accumulator.nativeAddonBindings,
        accumulator.modules,
      ),
    },
    limitations,
  };
};

const inspectNode = (
  source: string,
  node: t.Node,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): void => {
  const findings = {
    source,
    accumulator,
    maximum: limits.maxFindings,
  };
  inspectElectronStaticNode(node, findings);
  if (t.isCallExpression(node)) {
    inspectBundlerRegistration(source, node, accumulator, limits);
    inspectCall(node, findings);
  } else if (t.isNewExpression(node)) inspectCall(node, findings);
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
