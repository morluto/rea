import * as t from "@babel/types";

import { electronCalleePath } from "./electronStaticAnalysisValues.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type { JavaScriptBindingIndex } from "./javascriptSemanticState.js";
import {
  resolveElectronBrowserWindowAllocation,
  hasElectronBrowserWindowIdentity,
  electronBrowserWindowReceiverMayHaveChanged,
} from "./javascriptSemanticElectronReceiver.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** A renderer load belongs to an intact, source-proven BrowserWindow instance. */
export const isElectronRendererLoad = (
  callee: t.Node,
  site: t.Node,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): boolean => {
  callee = unwrapJavaScriptExpression(callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method !== "loadFile" && method !== "loadURL") return false;
  const receiver = resolveElectronBrowserWindowReceiver(
    callee.object,
    site,
    [method],
    context,
    index,
  );
  return (
    receiver !== undefined &&
    (receiver.path.length === 1 ||
      (receiver.path.length === 2 && receiver.path[0] === "webContents"))
  );
};

/** Source allocation identity, not a claim about runtime window/frame identity. */
export const resolveElectronBrowserWindowReceiver = (
  node: t.Node,
  site: t.Node,
  suffix: readonly string[],
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
):
  | { readonly owner: t.NewExpression; readonly path: readonly string[] }
  | undefined => {
  const allocation = resolveElectronBrowserWindowAllocation(
    node,
    suffix,
    index.bindings,
  );
  if (
    allocation === undefined ||
    !hasElectronBrowserWindowIdentity(allocation, {
      constructorPath: (callee) => electronCalleePath(callee, context),
      intactExport: (path) => context.electronExportIntact?.(path) === true,
    })
  )
    return undefined;
  // Only source-proven supported receivers justify the whole-file mutation pass.
  // Keep every alias's consumed path and check at the original invocation site.
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return electronBrowserWindowReceiverMayHaveChanged(
    allocation,
    site,
    index.referenceMayHaveChangedAt,
  )
    ? undefined
    : { owner: allocation.owner, path: allocation.path };
};
