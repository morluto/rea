import * as t from "@babel/types";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import { isUnshadowedGlobal } from "./javascriptSemanticMutationInitializers.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  ambientPathMayHaveChanged,
  opaqueCodeMayChangeGlobalRead,
} from "./javascriptSemanticEffectLog.js";

export const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

export const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Match lexical global identity; null denotes a direct global root. */
export const globalReferenceNamespace = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  path: readonly [string, ...string[]],
): string | null | undefined => {
  const { root, members } = electronMemberPath(callee);
  const matches = (expected: readonly string[]) =>
    members.length === expected.length &&
    members.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return null;
  const namespace = globalObjectName(root, state);
  return namespace !== undefined && matches(path) ? namespace : undefined;
};

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  if (ambientPathMayHaveChanged(state, ["global", ...path])) return false;
  const namespace = globalReferenceNamespace(callee, state, path);
  return (
    namespace !== undefined &&
    (namespace === null ||
      !ambientPathMayHaveChanged(state, ["global", namespace]))
  );
};

/**
 * An intrinsic global read: an unmodified global reference that no opaque code
 * may have rebound or replaced by the time its behavior is observed.
 */
export const isIntrinsicGlobalReference = (
  reference: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
  observedAt: t.Node = reference,
): boolean =>
  isUnmodifiedGlobalReference(reference, state, name) &&
  !opaqueCodeMayChangeGlobalRead(
    reference,
    state,
    typeof name === "string" ? name : name[0],
    observedAt,
  );

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) &&
  !ambientPathMayHaveChanged(state, ["import-meta", "url"]);
