import * as t from "@babel/types";

import { semanticComputedMethodKey } from "./javascriptSemanticEvaluationOrder.js";
import { semanticClassCandidates } from "./javascriptSemanticObjectReferences.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

type ClassNode = t.ClassDeclaration | t.ClassExpression;
interface Receiver {
  readonly owner: t.Node | undefined;
  readonly side?: "instance" | "static";
}

/** Class sides and possible local bases define candidates, never runtime equality. */
export const createSemanticThisReceiverKey = (
  state: JavaScriptSemanticAnalysisState,
): ((node: t.ThisExpression) => string) => {
  const receivers = new WeakMap<t.Node, Receiver>();
  let classComponents: ReturnType<typeof candidateClassComponents> | undefined;
  return (node) => {
    const pending: t.Node[] = [];
    let current: t.Node | undefined = node;
    let receiver: Receiver = { owner: undefined };
    while (current !== undefined) {
      const cached = receivers.get(current);
      if (cached !== undefined) {
        receiver = cached;
        break;
      }
      pending.push(current);
      const parent = state.parentsByNode.get(current);
      if (t.isDecorator(current)) {
        // Decorators, including parameter decorators, run at class definition.
        current = parent;
        while (current !== undefined && !t.isClass(current))
          current = state.parentsByNode.get(current);
        continue;
      }
      const boundary = receiverBoundary(parent, current, state);
      if (boundary !== undefined) {
        receiver = boundary;
        break;
      }
      current = parent;
    }
    for (const visited of pending) receivers.set(visited, receiver);
    const { owner, side } = receiver;
    if (t.isClass(owner)) {
      classComponents ??= candidateClassComponents(state);
      const family = classComponents(owner);
      return `this:${family.start ?? -1}:${family.end ?? -1}:${side}`;
    }
    return `this:${owner?.start ?? -1}:${owner?.end ?? -1}`;
  };
};

const receiverBoundary = (
  parent: t.Node | undefined,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): Receiver | undefined => {
  if (parent === undefined) return undefined;
  if (t.isFunction(parent) && !t.isArrowFunctionExpression(parent)) {
    if (semanticComputedMethodKey(parent, child)) return undefined;
    return t.isClassMethod(parent) || t.isClassPrivateMethod(parent)
      ? classReceiver(parent, state)
      : { owner: parent };
  }
  if (
    t.isStaticBlock(parent) ||
    ((t.isClassProperty(parent) ||
      t.isClassPrivateProperty(parent) ||
      t.isClassAccessorProperty(parent)) &&
      parent.value === child)
  )
    return classReceiver(parent, state);
  return undefined;
};

const classReceiver = (
  member:
    | t.ClassMethod
    | t.ClassPrivateMethod
    | t.ClassProperty
    | t.ClassPrivateProperty
    | t.ClassAccessorProperty
    | t.StaticBlock,
  state: JavaScriptSemanticAnalysisState,
): Receiver | undefined => {
  const body = state.parentsByNode.get(member);
  const owner = body === undefined ? undefined : state.parentsByNode.get(body);
  return t.isClass(owner)
    ? {
        owner,
        side: t.isStaticBlock(member) || member.static ? "static" : "instance",
      }
    : undefined;
};

/** External bases do not join classes; conditional local bases retain every candidate. */
const candidateClassComponents = (state: JavaScriptSemanticAnalysisState) => {
  const parents = new Map<ClassNode, ClassNode>();
  const sizes = new Map<ClassNode, number>();
  const representatives = new Map<ClassNode, ClassNode>();
  const root = (node: ClassNode): ClassNode => {
    const path: ClassNode[] = [];
    let current = node;
    let parent = parents.get(current);
    while (parent !== undefined && parent !== current) {
      path.push(current);
      current = parent;
      parent = parents.get(current);
    }
    for (const visited of path) parents.set(visited, current);
    return current;
  };
  for (const node of state.callableNodesById.values()) {
    if (!t.isClass(node) || node.superClass == null) continue;
    for (const base of semanticClassCandidates(node.superClass, state)) {
      let left = root(node);
      let right = root(base);
      if (left === right) continue;
      if ((sizes.get(left) ?? 1) < (sizes.get(right) ?? 1))
        [left, right] = [right, left];
      const first = representatives.get(left) ?? left;
      const second = representatives.get(right) ?? right;
      parents.set(right, left);
      sizes.set(left, (sizes.get(left) ?? 1) + (sizes.get(right) ?? 1));
      representatives.set(
        left,
        (first.start ?? -1) <= (second.start ?? -1) ? first : second,
      );
    }
  }
  return (node: ClassNode): ClassNode => {
    const component = root(node);
    return representatives.get(component) ?? component;
  };
};
