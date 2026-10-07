import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { semanticStaticPropertyKey } from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const members: string[] = [];
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const member = semanticStaticPropertyKey(node.property, node.computed);
    if (member === null || !t.isNode(node.object)) return undefined;
    members.push(member);
    node = node.object;
  }
  if (
    !t.isCallExpression(node) ||
    !t.isIdentifier(node.callee, { name: "require" })
  )
    return undefined;
  if (
    resolveSemanticBindingState(state, node.callee, "require") !== undefined ||
    semanticResolutionBlocked(state, node.callee, "require")
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  return specifier === undefined
    ? undefined
    : { specifier, importedPath: members.reverse() };
};
