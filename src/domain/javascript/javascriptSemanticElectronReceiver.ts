import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

export interface ElectronBrowserWindowAllocation {
  readonly owner: t.NewExpression;
  readonly path: readonly string[];
  readonly aliases: readonly {
    readonly receiver: t.Identifier;
    readonly path: readonly string[];
  }[];
}

export interface ElectronBrowserWindowIdentity {
  readonly constructorPath: (callee: t.Node) => readonly string[] | undefined;
  readonly intactExport: (path: readonly string[]) => boolean;
}

/** Resolve allocation and consumed paths without requesting mutation indexing. */
export const resolveElectronBrowserWindowAllocation = (
  node: t.Node,
  suffix: readonly string[],
  state: JavaScriptSemanticAnalysisState,
): ElectronBrowserWindowAllocation | undefined => {
  let receiver = unwrapJavaScriptExpression(node).node;
  const path = [...suffix];
  const seen = new Set<string>();
  const aliases: ElectronBrowserWindowAllocation["aliases"][number][] = [];
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
    const binding = resolveSemanticBindingState(state, receiver, receiver.name);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, state);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, state.parentsByNode)
        .hasDefiniteInitializer
    )
      return undefined;
    aliases.push({ receiver, path: [...path] });
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isNewExpression(receiver) && supportedReceiverPath(path)
    ? { owner: receiver, path, aliases }
    : undefined;
};

/** A local allocation is Electron only when its constructor and exports are intact. */
export const hasElectronBrowserWindowIdentity = (
  allocation: ElectronBrowserWindowAllocation,
  identity: ElectronBrowserWindowIdentity,
): boolean => {
  const constructor = identity.constructorPath(allocation.owner.callee);
  return (
    constructor?.length === 1 &&
    constructor[0] === "BrowserWindow" &&
    nativeOperationPaths(allocation.path, allocation.path).every((path) =>
      identity.intactExport([
        "electron",
        "BrowserWindow",
        "prototype",
        ...path,
      ]),
    )
  );
};

/** Query live producer effects; no recursive request to finish that producer. */
export const electronBrowserWindowReceiverMayHaveChanged = (
  allocation: ElectronBrowserWindowAllocation,
  site: t.Node,
  referenceMayHaveChangedAt: JavaScriptBindingIndex["referenceMayHaveChangedAt"],
): boolean =>
  allocation.aliases.some(({ receiver, path }) =>
    nativeOperationPaths(allocation.path, path).some(
      (consumed) =>
        referenceMayHaveChangedAt(site, receiver, consumed) ||
        // Replacing any traversed prototype can replace the native operation, too.
        consumed.some((_, index) =>
          referenceMayHaveChangedAt(site, receiver, [
            ...consumed.slice(0, index),
            "__proto__",
          ]),
        ),
    ),
  );

/** BrowserWindow loads forward to webContents; loadFile also calls its loadURL. */
const nativeOperationPaths = (
  allocationPath: readonly string[],
  consumedPath: readonly string[],
): readonly (readonly string[])[] => {
  const operation = allocationPath.at(-1);
  if (operation !== "loadFile" && operation !== "loadURL")
    return [consumedPath];
  const delegated =
    allocationPath.length === 1 ? ["webContents", operation] : consumedPath;
  const paths =
    allocationPath.length === 1 ? [consumedPath, delegated] : [consumedPath];
  return operation === "loadFile"
    ? [...paths, [...delegated.slice(0, -1), "loadURL"]]
    : paths;
};

const supportedReceiverPath = (path: readonly string[]): boolean => {
  const operation = path.at(-1);
  if (operation === "send" || operation === "postMessage")
    return (
      path[0] === "webContents" &&
      (path.length === 2 || (path.length === 3 && path[1] === "mainFrame"))
    );
  if (operation === "loadFile" || operation === "loadURL")
    return (
      path.length === 1 || (path.length === 2 && path[0] === "webContents")
    );
  return (
    path[0] === "webContents" &&
    ((path.length === 3 && path[1] === "ipc") ||
      (path.length === 4 && path[1] === "mainFrame" && path[2] === "ipc"))
  );
};
