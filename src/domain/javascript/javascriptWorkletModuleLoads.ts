import * as t from "@babel/types";

import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

/** `CSS` namespace worklets defined by the CSS Painting, Layout and Animation Worklet APIs. */
const CSS_WORKLETS = ["paintWorklet", "layoutWorklet", "animationWorklet"];

/** Constructors whose instances read `audioWorklet` from `BaseAudioContext`. */
const AUDIO_CONTEXTS = ["AudioContext", "OfflineAudioContext"];

const prototypeMemberMayHaveChanged = (
  bindings: JavaScriptSemanticAnalysisState,
  owners: readonly string[],
  member: string,
): boolean =>
  owners.some((owner) =>
    [member, "__proto__"].some((key) => {
      const path = ["global", owner, "prototype", key];
      return (
        bindings.ambientWrites.covers(path) ||
        bindings.ambientEscapes.covers(path)
      );
    }),
  );

/**
 * Prove `<context>.audioWorklet.addModule()` on a context that an unmodified
 * global constructor created, directly or through stable bindings. The getter
 * and `addModule` are inherited, so a visible write to either member, to an
 * owning prototype, or to a followed reference rejects the call. An earlier
 * call that receives the context or its worklet, including a previous
 * `addModule`, is such a possible change. Undefined requests shared
 * member-mutation facts.
 */
const isAudioWorkletModuleLoad = (
  node: t.CallExpression | t.OptionalCallExpression,
  callee: t.MemberExpression | t.OptionalMemberExpression,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => {
  const worklet = unwrapJavaScriptExpression(callee.object).node;
  if (
    (!t.isMemberExpression(worklet) &&
      !t.isOptionalMemberExpression(worklet)) ||
    semanticStaticPropertyName(worklet.property, worklet.computed) !==
      "audioWorklet"
  )
    return false;
  let receiver = unwrapJavaScriptExpression(worklet.object).node;
  const seen = new Set<string>();
  while (t.isIdentifier(receiver)) {
    if (
      index !== undefined &&
      (index.referenceMayHaveChangedAt(node, receiver, [
        "audioWorklet",
        "addModule",
      ]) ||
        index.referenceMayHaveChangedAt(node, receiver, ["__proto__"]))
    )
      return false;
    const binding = resolveSemanticBindingState(
      bindings,
      receiver,
      receiver.name,
    );
    if (binding === undefined || seen.has(binding.bindingId)) return false;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, bindings);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, bindings).hasDefiniteInitializer
    )
      return false;
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isNewExpression(receiver)) return false;
  const construction = receiver;
  const constructor = AUDIO_CONTEXTS.find((name) =>
    isUnmodifiedGlobalReference(construction.callee, bindings, name),
  );
  if (
    constructor === undefined ||
    prototypeMemberMayHaveChanged(
      bindings,
      [constructor, "BaseAudioContext"],
      "audioWorklet",
    ) ||
    prototypeMemberMayHaveChanged(
      bindings,
      ["AudioWorklet", "Worklet"],
      "addModule",
    ) ||
    semanticOpaqueGlobalMayHaveChanged(callee, bindings)
  )
    return false;
  return index === undefined && seen.size > 0 ? undefined : true;
};

const isWorkletModuleLoad = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyName(callee.property, callee.computed) !== "addModule"
  )
    return false;
  // Like `navigator.serviceWorker.register`, the complete called path must
  // retain its platform identity.
  if (
    CSS_WORKLETS.some((worklet) =>
      isUnmodifiedGlobalReference(node.callee, bindings, [
        "CSS",
        worklet,
        "addModule",
      ]),
    )
  )
    return true;
  return isAudioWorkletModuleLoad(node, callee, bindings, index);
};

/** Prove a platform worklet module load; mutation facts are indexed on demand. */
export const createWorkletModuleLoadQuery =
  (index: JavaScriptBindingIndex): ((node: t.Node) => boolean) =>
  (node) => {
    const proof = isWorkletModuleLoad(node, index.bindings);
    if (proof !== undefined) return proof;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    return isWorkletModuleLoad(node, index.bindings, index) === true;
  };
