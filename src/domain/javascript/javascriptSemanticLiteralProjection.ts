import { semanticExactResultOperand } from "./javascriptSemanticExpressionResults.js";
import * as t from "@babel/types";

import {
  semanticLiteralContainer,
  semanticLiteralProperty,
  semanticFinalObjectSlot,
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticPatternInitializationPrecedesRead } from "./javascriptSemanticEvaluationOrder.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import { syntaxEvaluationAlwaysThrows } from "./javascriptSymbolicControlFlow.js";
import { semanticPatternCompletionBeforeTarget } from "./javascriptGeneratorConsumerPhases.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticInitializer,
  JavaScriptSemanticLiteralMemberEffect,
} from "./javascriptSemanticState.js";

type LiteralProjectionSlot =
  | { readonly kind: "value"; readonly node: t.Node }
  | { readonly kind: "accessor"; readonly node: t.ObjectMethod }
  | { readonly kind: "inert-data" }
  | { readonly kind: "undefined" }
  | { readonly kind: "unknown" | "invalid" };

/** Shared capture ordering and the sole consumer's owned result exposure. */
const literalEffectCanPrecede = (
  effect: JavaScriptSemanticLiteralMemberEffect,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
): boolean => {
  if (
    ownedResultEscape !== undefined &&
    effect.kind === "escape" &&
    effect.path.length === 0 &&
    effect.node === ownedResultEscape
  )
    return false;
  const patternOrder =
    effect.node === undefined
      ? undefined
      : semanticPatternInitializationPrecedesRead(
          capture,
          effect.node,
          state.parentsByNode,
        );
  return !(
    patternOrder ??
    semanticEffectTiming(capture, effect.node, state) === "after"
  );
};

/** Enumeration cannot ignore newly added own keys, even for an empty remainder. */
export const semanticLiteralOwnKeysStable = (
  container: t.ObjectExpression | t.ArrayExpression | t.Function,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
  excluded: ReadonlySet<string> = new Set(),
): boolean =>
  !state.literalMemberEffects
    ?.get(container)
    ?.some(
      (effect) =>
        literalEffectCanPrecede(effect, capture, state, ownedResultEscape) &&
        (effect.path.length === 0 ||
          (effect.kind === "write" &&
            effect.path.length === 1 &&
            (effect.path[0] === null ||
              !excluded.has(String(effect.path[0]))))),
    );

/** Share slot validity and iterator exhaustion without conflating undefined with unknown. */
export const semanticLiteralProjectionSlot = (
  node: t.Node,
  key: string | number,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly onLiteralProjection?: () => void;
    readonly ownedResultEscape?: t.Node;
  },
): LiteralProjectionSlot => {
  const exactResult = (node: t.Node) => semanticExactResultOperand(node, state);
  const container = semanticLiteralContainer(node, exactResult);
  if (container !== undefined) options?.onLiteralProjection?.();
  if (typeof key === "number" && state.arrayIterationUnknown === true)
    return { kind: "invalid" };
  if (container === undefined) return { kind: "unknown" };
  if (
    container !== undefined &&
    state.literalMemberEffects?.get(container)?.some((effect) => {
      const [affected] = effect.path;
      const affectsSlot =
        effect.path.length === 0 ||
        (effect.kind === "write" &&
          effect.path.length === 1 &&
          affected !== undefined &&
          (semanticPropertyPathKeyMatches(affected, String(key)) ||
            (t.isArrayExpression(container) &&
              semanticArrayIndex(key) !== null &&
              affected === "length")));
      if (!affectsSlot) return false;
      return literalEffectCanPrecede(
        effect,
        capture,
        state,
        options?.ownedResultEscape,
      );
    })
  )
    return { kind: "invalid" };
  const value = semanticLiteralProperty(node, key, exactResult);
  if (value !== undefined) return { kind: "value", node: value };
  if (t.isObjectExpression(container)) {
    const slot = semanticFinalObjectSlot(container, String(key));
    if (slot.kind === "undefined") return { kind: "undefined" };
    const member = slot.kind === "member" ? slot.node : undefined;
    // An ordinary method is an own data property: copying it cannot invoke its
    // body. That read proof does not resolve the copied function's exact value.
    if (t.isObjectMethod(member) && member.kind === "method")
      return { kind: "inert-data" };
    if (t.isObjectMethod(member) && member.kind === "get")
      return { kind: "accessor", node: member };
    // Missing own data is undefined only when neither dynamic own keys nor a
    // prototype can provide it. Collected mutations still own that proof.
    const nullPrototype = container.properties.some(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        semanticStaticPropertyKey(property.key, false) === "__proto__" &&
        t.isNullLiteral(unwrapJavaScriptExpression(property.value).node),
    );
    if (
      slot.kind === "missing" &&
      nullPrototype &&
      container.properties.every(
        (property) =>
          !t.isSpreadElement(property) &&
          semanticStaticPropertyKey(property.key, property.computed) !== null,
      )
    ) {
      state.memberMutationFactsPhase ??= "requested";
      if (
        state.memberMutationFactsPhase === "indexed" &&
        semanticLiteralOwnKeysStable(
          container,
          capture,
          state,
          options?.ownedResultEscape,
        )
      )
        return { kind: "undefined" };
    }
  }
  // Iterator exhaustion ignores inherited indexed properties; a hole within
  // the length does not. Spreads leave the actual length unknown.
  if (
    typeof key === "number" &&
    t.isArrayExpression(container) &&
    key >= container.elements.length &&
    !container.elements.some((item) => t.isSpreadElement(item))
  )
    return { kind: "undefined" };
  return { kind: "unknown" };
};

/** Own enumerable literal slots copied by rest, excluding keys already consumed. */
export const semanticLiteralRestSlots = (
  node: t.Node,
  excluded: ReadonlySet<string>,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
): readonly LiteralProjectionSlot[] | undefined => {
  const container = semanticLiteralContainer(node, (expression) =>
    semanticExactResultOperand(expression, state),
  );
  if (
    container !== undefined &&
    !semanticLiteralOwnKeysStable(
      container,
      capture,
      state,
      ownedResultEscape,
      excluded,
    )
  )
    return undefined;
  if (t.isArrayExpression(container)) {
    if (container.elements.some((element) => t.isSpreadElement(element)))
      return undefined;
    return container.elements.flatMap((element, index) =>
      element === null || excluded.has(String(index))
        ? []
        : [
            semanticLiteralProjectionSlot(
              node,
              String(index),
              capture,
              state,
              ownedResultEscape === undefined
                ? undefined
                : { ownedResultEscape },
            ),
          ],
    );
  }
  const value = unwrapJavaScriptExpression(node).node;
  const literal = readExactJavaScriptLiteral(value);
  // Primitive own slots are inert data (string indices); boxing reads no getters.
  if (
    (literal.found && literal.value !== null) ||
    t.isBigIntLiteral(value) ||
    (t.isUnaryExpression(value, { operator: "-" }) &&
      t.isBigIntLiteral(value.argument))
  )
    return [];
  if (!t.isObjectExpression(container)) return undefined;
  const keys = new Set<string>();
  for (const property of container.properties) {
    if (t.isSpreadElement(property)) return undefined;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) return undefined;
    if (
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      key === "__proto__"
    )
      continue;
    if (!excluded.has(key)) keys.add(key);
  }
  return [...keys].map((key) =>
    semanticLiteralProjectionSlot(
      node,
      key,
      capture,
      state,
      ownedResultEscape === undefined ? undefined : { ownedResultEscape },
    ),
  );
};

/** Resolve fresh-literal slots once, preserving capture order and iteration facts. */
export const semanticLiteralInitializerProjection = (
  initializer: JavaScriptSemanticInitializer,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): JavaScriptSemanticInitializer | undefined => {
  // Projection cannot initialize a binding if its owning RHS never completes.
  // Possible failures remain uncertain rather than rejecting useful metadata.
  if (syntaxEvaluationAlwaysThrows(initializer.node)) return undefined;
  // Selecting a literal slot is useful only after the preceding binding work
  // completes. Stop at this binding, not at later slots in the declaration.
  if (
    initializer.bindingNode !== undefined &&
    initializer.projection.length > 0
  ) {
    let owner: t.Node | undefined = initializer.bindingNode;
    while (
      owner !== undefined &&
      !t.isVariableDeclarator(owner) &&
      !t.isFunction(owner) &&
      !t.isProgram(owner)
    )
      owner = state.parentsByNode.get(owner);
    if (t.isVariableDeclarator(owner) && !t.isIdentifier(owner.id)) {
      const completion = semanticPatternCompletionBeforeTarget(
        owner.id,
        initializer.node,
        initializer.bindingNode,
        state,
        () => false,
      );
      if (completion === "blocked" || completion === "suspended-blocked")
        return undefined;
    }
  }
  let node = initializer.node;
  let projection = initializer.projection;
  while (projection.length > 0) {
    const key = projection[0];
    if (typeof key !== "string" && typeof key !== "number") return undefined;
    const selected = semanticLiteralProjectionSlot(
      node,
      key,
      initializer.bindingNode ?? initializer.node,
      state,
      onLiteralProjection === undefined ? undefined : { onLiteralProjection },
    );
    if (selected.kind === "invalid" || selected.kind === "accessor")
      return undefined;
    if (selected.kind !== "value") break;
    node = selected.node;
    projection = projection.slice(1);
  }
  return { ...initializer, node, projection };
};
