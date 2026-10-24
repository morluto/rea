import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  unwrapJavaScriptExpression,
  readExactJavaScriptNormalResult,
  semanticFinalObjectSlot,
  semanticStaticPropertyKey,
  semanticDirectFunctionResult,
  semanticMemberChain,
} from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  semanticPromiseFulfilledValueIdentity,
  semanticExactValueIdentity,
} from "./javascriptSemanticPromiseIdentity.js";
import { webSocketInitializerDominatesRead } from "./javascriptWebSocketExecution.js";
import {
  syntaxEvaluationAlwaysThrows,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";
import { semanticLiteralOwnKeysStable } from "./javascriptSemanticLiteralProjection.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticPrototypeLookupMayChange,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";

/** Identity, initialization and prior relevant mutations are separate obligations. */
const importOptionValue = (
  raw: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  attributes: boolean,
  onLiteralProjection?: () => void,
): t.Node | undefined => {
  const result = semanticExactValueIdentity(raw, state, onLiteralProjection);
  if (
    result === undefined ||
    result.aliases.some(({ read, initializer }) => {
      if (
        !webSocketInitializerDominatesRead(
          initializer.node,
          read,
          state,
          initializer.bindingNode,
        )
      )
        return true;
      const binding = resolveSemanticBindingState(state, read, read.name);
      return (
        binding === undefined ||
        [...binding.memberWrites, ...binding.escapedPaths].some(
          (effect) =>
            effect.node !== capture &&
            semanticEffectTiming(capture, effect.node, state) !== "after" &&
            (attributes ||
              semanticPrototypeLookupMayChange(effect.path, "with")),
        )
      );
    })
  )
    return undefined;
  return result.node;
};

/** Fresh syntax objects expose only known own keys and known built-in prototypes. */
const importOptionObject = (node: t.Node): boolean =>
  syntaxEvaluationCannotThrow(node) &&
  (t.isArrayExpression(node) ||
    ((t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isFunctionDeclaration(node)) &&
      !node.async &&
      !node.generator) ||
    (t.isObjectExpression(node) &&
      node.properties.every(
        (property) =>
          !t.isSpreadElement(property) &&
          semanticStaticPropertyKey(property.key, property.computed) !== null,
      )));

const importOptionOwnKeysStable = (
  node: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  attributes = false,
): boolean =>
  !(
    t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    (attributes && t.isFunction(node))
  ) || semanticLiteralOwnKeysStable(node, capture, state, capture);

/** A valid options record is separate from evaluating the options expression. */
const importOptionsCanComplete = (
  options: t.Node | null | undefined,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): boolean => {
  if (options == null) return true;
  onLiteralProjection?.();
  const node = importOptionValue(
    options,
    capture,
    state,
    false,
    onLiteralProjection,
  );
  if (node === undefined) return false;
  if (isUnshadowedGlobal(node, state, "undefined")) return true;
  const normal = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (normal.found) return normal.value === undefined;
  if (
    !importOptionObject(node) ||
    !importOptionOwnKeysStable(node, capture, state)
  )
    return false;
  const slot = t.isObjectExpression(node)
    ? semanticFinalObjectSlot(node, "with")
    : undefined;
  // A setter-only own descriptor reads as undefined and shadows prototypes.
  if (slot?.kind === "undefined") return true;
  if (slot?.kind === "unknown") return false;
  const attributes = slot?.kind === "member" ? slot.node : undefined;
  if (attributes !== undefined) {
    // Reading an ordinary method returns its inert function object. Its
    // built-in own properties are non-enumerable, so attribute validation has
    // no user-defined entry to evaluate.
    if (t.isObjectMethod(attributes, { kind: "method" }))
      return importOptionOwnKeysStable(attributes, capture, state, true);
    // Get(options, "with") invokes an own getter before validating attributes.
    // Only a direct normal result is evidence; arbitrary getter bodies stay unknown.
    const getter = t.isObjectMethod(attributes, { kind: "get" })
      ? semanticDirectFunctionResult(attributes)
      : undefined;
    if (getter?.kind === "undefined") return true;
    const rawValue = t.isObjectProperty(attributes)
      ? attributes.value
      : getter?.kind === "value"
        ? getter.node
        : undefined;
    if (
      rawValue === undefined ||
      (getter !== undefined &&
        !syntaxEvaluationCannotThrow(rawValue) &&
        !isUnshadowedGlobal(rawValue, state, "undefined"))
    )
      return false;
    const value = importOptionValue(
      rawValue,
      capture,
      state,
      true,
      onLiteralProjection,
    );
    if (value === undefined) return false;
    if (isUnshadowedGlobal(value, state, "undefined")) return true;
    const result = readExactJavaScriptNormalResult(
      value,
      syntaxEvaluationCannotThrow,
    );
    return result.found
      ? result.value === undefined
      : importOptionObject(value) &&
          (t.isObjectExpression(value)
            ? value.properties.length === 0
            : t.isArrayExpression(value)
              ? value.elements.length === 0
              : true) &&
          importOptionOwnKeysStable(value, capture, state, true);
  }
  const prototype = t.isObjectExpression(node)
    ? node.properties.find(
        (property) =>
          t.isObjectProperty(property) &&
          !property.computed &&
          !property.shorthand &&
          semanticStaticPropertyKey(property.key, false) === "__proto__",
      )
    : undefined;
  if (prototype !== undefined)
    return t.isObjectProperty(prototype) && t.isNullLiteral(prototype.value);
  // Array.prototype.with is itself a function with no enumerable attributes;
  // both replacing it and changing its properties invalidate this proof.
  const prototypes = [
    "Object",
    ...(t.isArrayExpression(node)
      ? ["Array"]
      : t.isFunction(node)
        ? ["Function"]
        : []),
  ];
  return prototypes.every(
    (name) =>
      !state.ambientReferenceEffects.some(
        (effect) =>
          semanticEffectTiming(capture, effect.node, state) !== "after" &&
          effect.path
            .slice(0, 3)
            .every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", name, "prototype"][index]!,
              ),
            ) &&
          semanticPrototypeLookupMayChange(effect.path.slice(3), "with"),
      ),
  );
};

/** Recover an exact export of a fulfilled literal import, never its promise. */
export const semanticAwaitedImportOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): JavaScriptModuleOrigin | undefined => {
  const chain = semanticMemberChain(node);
  if (chain === undefined || !t.isAwaitExpression(chain.root)) return undefined;
  const result = semanticPromiseFulfilledValueIdentity(
    chain.root.argument,
    state,
    onLiteralProjection,
  );
  if (
    result === undefined ||
    result.aliases.some(
      ({ read, initializer }) =>
        !webSocketInitializerDominatesRead(
          initializer.node,
          read,
          state,
          initializer.bindingNode,
        ),
    )
  )
    return undefined;
  const imported = unwrapJavaScriptExpression(result.node).node;
  if (syntaxEvaluationAlwaysThrows(imported)) return undefined;
  const options = t.isImportExpression(imported)
    ? imported.options
    : t.isCallExpression(imported) && t.isImport(imported.callee)
      ? imported.arguments[1]
      : undefined;
  if (!importOptionsCanComplete(options, imported, state, onLiteralProjection))
    return undefined;
  const source = t.isImportExpression(imported)
    ? imported.source
    : t.isCallExpression(imported) && t.isImport(imported.callee)
      ? imported.arguments[0]
      : undefined;
  const specifier = stringValue(source);
  return specifier === undefined
    ? undefined
    : { specifier, importedPath: chain.members, resolutionMode: "import" };
};
