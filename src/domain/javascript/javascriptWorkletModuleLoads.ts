import * as t from "@babel/types";

import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  ambientPathMayHaveChanged,
  opaqueCodeMayChangeGlobalRead,
} from "./javascriptSemanticEffectLog.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticGlobalReference.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
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

/** Prototypes that provide `addModule`, nearest first; every worklet inherits it from `Worklet`. */
const CSS_WORKLET_PROTOTYPES = ["Worklet"];

/** An `AudioWorklet` reaches `Worklet.prototype` through its own prototype. */
const AUDIO_WORKLET_PROTOTYPES = ["AudioWorklet", "Worklet"];

/** Members of a bound audio context whose change redirects its `addModule`. */
const AUDIO_CONTEXT_PATHS = [
  ["audioWorklet", "addModule"],
  ["audioWorklet", "__proto__"],
  ["__proto__"],
] as const;

/** A visible write to, or an escape of, a prototype member or its link may have replaced it. */
const prototypeMemberMayHaveChanged = (
  bindings: JavaScriptSemanticAnalysisState,
  owners: readonly string[],
  member: string,
): boolean =>
  owners.some((owner) =>
    [member, "__proto__"].some((key) =>
      ambientPathMayHaveChanged(
        bindings,
        ["global", owner, "prototype", key],
        "contents",
      ),
    ),
  );

/**
 * The one guard for the inherited `addModule` of every worklet, whatever the
 * receiver: no visible change to the prototypes that provide it and no earlier
 * `eval` or `Function` code.
 */
const inheritedAddModuleMayHaveChanged = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  prototypes: readonly string[],
): boolean =>
  prototypeMemberMayHaveChanged(bindings, prototypes, "addModule") ||
  opaqueCodeMayChangeGlobalRead(callee, bindings, "Worklet");

/**
 * Prove the called `CSS.<worklet>.addModule` path. Like
 * `navigator.serviceWorker.register`, the complete path must retain its
 * platform identity; a replaced prototype link of the worklet redirects the
 * inherited method as well. Escapes of the worklet are not queried: each
 * method call retains its own receiver as an escape, so a file-wide query
 * would reject every load.
 */
const isCssWorkletReceiver = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean =>
  CSS_WORKLETS.some(
    (worklet) =>
      isUnmodifiedGlobalReference(callee, bindings, [
        "CSS",
        worklet,
        "addModule",
      ]) &&
      !ambientPathMayHaveChanged(bindings, [
        "global",
        "CSS",
        worklet,
        "__proto__",
        "addModule",
      ]),
  );

const audioContextMayHaveChanged = (
  index: Pick<JavaScriptBindingIndex, "mayObserve">,
  site: t.Node,
  context: t.Node,
): boolean =>
  AUDIO_CONTEXT_PATHS.some((path) => index.mayObserve(site, context, path));

/**
 * Prove the receiver of `<context>.audioWorklet.addModule()`: a context that an
 * unmodified global constructor created, directly or through stable bindings.
 * The `audioWorklet` getter is inherited, so a visible write to it, to an
 * owning prototype, or to a followed reference rejects the call. An earlier
 * call that receives the context or its worklet, including a previous
 * `addModule`, is such a possible change. Undefined requests shared
 * member-mutation facts.
 */
const isAudioWorkletReceiver = (
  node: t.CallExpression | t.OptionalCallExpression,
  callee: t.MemberExpression | t.OptionalMemberExpression,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "mayObserve">,
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
      audioContextMayHaveChanged(index, node, receiver)
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
    )
  )
    return false;
  return index === undefined && seen.size > 0 ? undefined : true;
};

const isWorkletModuleLoad = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "mayObserve">,
): boolean | undefined => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyName(callee.property, callee.computed) !== "addModule"
  )
    return false;
  const css = isCssWorkletReceiver(node.callee, bindings);
  const receiver = css
    ? true
    : isAudioWorkletReceiver(node, callee, bindings, index);
  const prototypes = css ? CSS_WORKLET_PROTOTYPES : AUDIO_WORKLET_PROTOTYPES;
  if (
    receiver === false ||
    inheritedAddModuleMayHaveChanged(callee, bindings, prototypes)
  )
    return false;
  return receiver;
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
