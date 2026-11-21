import * as t from "@babel/types";

import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { isIntrinsicGlobalReference } from "./javascriptSemanticGlobalReference.js";
import {
  ambientPathMayHaveChanged,
  ambientPathMayObserveAt,
} from "./javascriptSemanticEffectLog.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** An intrinsic constructor whose instances expose methods a reader relies on. */
interface JavaScriptIntrinsicInstanceMethods {
  readonly constructor: string;
  readonly methods: readonly string[];
  /** Instance members the constructor itself calls when given arguments. */
  readonly constructionHooks?: readonly string[];
}

/**
 * Whether a source-visible write or escape may have replaced a member on the
 * intrinsic prototype, on `Object.prototype`, or the prototype link itself.
 * With `read`, only effects that may run before that read count; without it,
 * the answer holds at every read site.
 */
export const intrinsicPrototypeMemberMayHaveChanged = (
  state: JavaScriptSemanticAnalysisState,
  constructor: string,
  member: string,
  read?: t.Node,
  observes: "value" | "contents" = "contents",
): boolean =>
  [constructor, "Object"].some((owner) =>
    [member, "__proto__"].some((key) => {
      const path = ["global", owner, "prototype", key];
      return read === undefined
        ? ambientPathMayHaveChanged(state, path, observes)
        : ambientPathMayObserveAt(state, read, path, observes);
    }),
  );

/**
 * Prove that a call invokes an unchanged intrinsic method on an instance that
 * `new <constructor>()` created and stable aliases carried to the call. Every
 * alias in the receiver walk asks the shared member-effect owner whether the
 * method or the instance's prototype link may have changed before the call.
 * Without `index`, a walk through an alias returns undefined: the proof needs
 * the shared member-mutation facts.
 */
export const isIntrinsicInstanceMethodCall = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
  intrinsic: JavaScriptIntrinsicInstanceMethods,
  index?: Pick<JavaScriptBindingIndex, "mayObserve">,
): boolean | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyName(callee.property, callee.computed);
  if (method === undefined || !intrinsic.methods.includes(method)) return false;
  if (
    intrinsicPrototypeMemberMayHaveChanged(
      bindings,
      intrinsic.constructor,
      method,
    )
  )
    return false;
  let receiver = unwrapJavaScriptExpression(callee.object).node;
  const seen = new Set<string>();
  while (t.isIdentifier(receiver)) {
    if (
      index !== undefined &&
      (index.mayObserve(node, receiver, [method]) ||
        index.mayObserve(node, receiver, ["__proto__"]))
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
  if (
    !t.isNewExpression(receiver) ||
    !isIntrinsicGlobalReference(
      receiver.callee,
      bindings,
      intrinsic.constructor,
      callee,
    )
  )
    return false;
  // A hook the constructor invokes can install its own methods on the
  // instance before the constructed value is read.
  if (
    receiver.arguments.length > 0 &&
    (intrinsic.constructionHooks ?? []).some((hook) =>
      intrinsicPrototypeMemberMayHaveChanged(
        bindings,
        intrinsic.constructor,
        hook,
      ),
    )
  )
    return false;
  return index === undefined && seen.size > 0 ? undefined : true;
};

/** Map construction from an iterable calls the instance's `set` hook. */
export const isIntrinsicMapLookup = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "mayObserve">,
): boolean | undefined =>
  isIntrinsicInstanceMethodCall(
    node,
    bindings,
    {
      constructor: "Map",
      methods: ["get", "delete"],
      constructionHooks: ["set"],
    },
    index,
  );
