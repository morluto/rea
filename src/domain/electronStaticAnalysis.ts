import type * as t from "@babel/types";

import { inspectElectronBrowserNode } from "./electronStaticAnalysisBrowser.js";
import { inspectElectronIpcNode } from "./electronStaticAnalysisIpc.js";
import { inspectElectronNativeNode } from "./electronStaticAnalysisNative.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** Collect Electron-specific syntax during the shared inert AST traversal. */
export const inspectElectronStaticNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  inspectElectronBrowserNode(node, context);
  inspectElectronIpcNode(node, context);
  inspectElectronNativeNode(node, context);
};
