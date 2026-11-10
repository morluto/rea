import * as t from "@babel/types";

import {
  electronCalleePath,
  electronCandidateAuthority,
} from "./electronStaticAnalysisValues.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";
import {
  ELECTRON_WINDOW_CONSTRUCTOR_SURFACES,
  electronWindowConstructor,
  type ElectronWindowConstructorSurface,
} from "./electronWindowConstructorSurfaces.js";

/** A renderer load belongs to an intact, source-proven BrowserWindow instance. */
export const electronRendererLoadAuthority = (
  callee: t.Node,
  site: t.Node,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): { readonly loader_authority?: "candidate" } | undefined => {
  callee = unwrapJavaScriptExpression(callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return undefined;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method !== "loadFile" && method !== "loadURL") return undefined;
  const receiver = resolveElectronBrowserWindowReceiver(
    callee.object,
    site,
    [method],
    context,
    index,
  );
  return receiver !== undefined &&
    (receiver.path.length === 1 ||
      (receiver.path.length === 2 && receiver.path[0] === "webContents"))
    ? receiver.authority
    : undefined;
};

/** Source allocation identity, not a claim about runtime window/frame identity. */
export const resolveElectronBrowserWindowReceiver = (
  node: t.Node,
  site: t.Node,
  suffix: readonly string[],
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
):
  | {
      readonly owner: t.NewExpression;
      readonly path: readonly string[];
      readonly authority: { readonly loader_authority?: "candidate" };
    }
  | undefined => {
  let receiver = unwrapJavaScriptExpression(node).node;
  const path = [...suffix];
  const seen = new Set<string>();
  const aliases: { receiver: t.Identifier; path: readonly string[] }[] = [];
  for (;;) {
    if (
      t.isMemberExpression(receiver) ||
      t.isOptionalMemberExpression(receiver)
    ) {
      const member = semanticStaticPropertyKey(
        receiver.property,
        receiver.computed,
      );
      if (member === null) return undefined;
      path.unshift(member);
      receiver = unwrapJavaScriptExpression(receiver.object).node;
      continue;
    }
    if (!t.isIdentifier(receiver)) break;
    const binding = index.bindingForReferenceAt(receiver);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, index.bindings);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, index.bindings)
        .hasDefiniteInitializer
    )
      return undefined;
    aliases.push({ receiver, path: [...path] });
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isNewExpression(receiver)) return undefined;
  const constructorPath = electronCalleePath(receiver.callee, context);
  const constructorName =
    constructorPath?.length === 1 ? constructorPath[0] : undefined;
  const constructor =
    constructorName === undefined
      ? undefined
      : electronWindowConstructor(constructorName);
  // Receivers are admitted only for constructors whose capability entry proves
  // the addressed surface, so a window-like construction never gains IPC or
  // load facts the runtime would not produce.
  if (
    constructor === undefined ||
    !supportedReceiverPath(
      path,
      ELECTRON_WINDOW_CONSTRUCTOR_SURFACES[constructor],
    )
  )
    return undefined;
  if (
    context.electronExportIntact?.([
      "electron",
      constructor,
      "prototype",
      ...path,
    ]) !== true
  )
    return undefined;
  // Only source-proven supported receivers justify the whole-file mutation pass.
  // Keep every alias's consumed path and check at the original invocation site.
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  for (const alias of aliases)
    if (index.referenceMayHaveChangedAt(site, alias.receiver, alias.path))
      return undefined;
  return {
    owner: receiver,
    path,
    authority: electronCandidateAuthority(receiver.callee, context),
  };
};

const supportedReceiverPath = (
  path: readonly string[],
  surfaces: ElectronWindowConstructorSurface,
): boolean => {
  // A constructor that owns its webContents accepts preferences, preload,
  // renderer loads and scoped IPC through it; one that does not owns only the
  // native frame, so none of those surfaces exist on the instance.
  if (!surfaces.webContents) return false;
  const operation = path.at(-1);
  if (operation === "setWindowOpenHandler")
    return path.length === 2 && path[0] === "webContents";
  if (operation === "loadFile" || operation === "loadURL")
    return (
      (surfaces.selfLoad && path.length === 1) ||
      (path.length === 2 && path[0] === "webContents")
    );
  return (
    path[0] === "webContents" &&
    ((path.length === 3 && path[1] === "ipc") ||
      (path.length === 4 && path[1] === "mainFrame" && path[2] === "ipc"))
  );
};
