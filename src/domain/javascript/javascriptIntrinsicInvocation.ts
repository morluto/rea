import * as t from "@babel/types";

import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/** Expand only literal array spreads whose positional arguments are all known. */
export const expandJavaScriptInvocationArguments = (
  arguments_: readonly t.CallExpression["arguments"][number][],
): t.CallExpression["arguments"] => {
  const expanded: t.CallExpression["arguments"] = [];
  const pending = [...arguments_].reverse();
  while (pending.length > 0) {
    const argument = pending.pop();
    if (argument === undefined) break;
    const array = t.isSpreadElement(argument)
      ? unwrapJavaScriptExpression(argument.argument).node
      : undefined;
    if (
      t.isArrayExpression(array) &&
      array.elements.every(
        (element) => t.isExpression(element) || t.isSpreadElement(element),
      )
    )
      for (let index = array.elements.length - 1; index >= 0; index -= 1) {
        const element = array.elements[index];
        if (element !== null && element !== undefined) pending.push(element);
      }
    else expanded.push(argument);
  }
  return expanded;
};

const arrayArguments = (node: t.Node | undefined) => {
  const array =
    node === undefined ? undefined : unwrapJavaScriptExpression(node).node;
  if (
    !t.isArrayExpression(array) ||
    array.elements.some((element) => element === null)
  )
    return undefined;
  const expanded = expandJavaScriptInvocationArguments(
    array.elements.filter(
      (element): element is t.Expression | t.SpreadElement => element !== null,
    ),
  );
  return expanded.every((element) => t.isExpression(element))
    ? expanded.filter((element): element is t.Expression =>
        t.isExpression(element),
      )
    : undefined;
};

const invocationArguments = (
  method: "call" | "apply",
  arguments_: JavaScriptIntrinsicInvocation["arguments"],
) =>
  t.isSpreadElement(arguments_?.[0])
    ? undefined
    : method === "apply"
      ? arrayArguments(arguments_?.[1])
      : arguments_?.slice(1);

/**
 * Normalize known invocation syntax once, retaining bound argument prefixes.
 * Binding a function alone is not a write; only its eventual call is examined.
 */
export const resolveJavaScriptIntrinsicInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPath: (node: t.Node) => readonly string[] | undefined,
  boundIntrinsic: (node: t.Node) => JavaScriptIntrinsicInvocation | undefined,
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
): JavaScriptIntrinsicInvocation | undefined => {
  const visited = new Set<t.Node>();
  let callee: t.Node = node.callee;
  let arguments_: JavaScriptIntrinsicInvocation["arguments"] =
    expandJavaScriptInvocationArguments(node.arguments);
  let receiver: t.Node | undefined;
  let explicitReceiver = false;
  for (;;) {
    callee = unwrapJavaScriptExpression(callee).node;
    if (visited.has(callee)) return undefined;
    visited.add(callee);
    let path = intrinsicPath(callee);
    if (path !== undefined && intrinsicReadChanged(callee, path))
      return { kind: "opaque", path, arguments: undefined };
    if (path === undefined) {
      if (
        t.isMemberExpression(callee) ||
        t.isOptionalMemberExpression(callee)
      ) {
        const method = semanticStaticPropertyKey(
          callee.property,
          callee.computed,
        );
        if (method === "call" || method === "apply") {
          const bound = boundIntrinsic(callee.object);
          if (
            bound !== undefined &&
            intrinsicReadChanged(callee, [...bound.path, method])
          )
            return { kind: "opaque", path: bound.path, arguments: undefined };
          receiver = arguments_?.[0];
          explicitReceiver = true;
          callee = callee.object;
          arguments_ = invocationArguments(method, arguments_);
          continue;
        }
      }
      const bound = boundIntrinsic(callee);
      if (bound === undefined) return undefined;
      if (bound.kind === "opaque") return bound;
      path = bound.path;
      receiver = bound.receiver;
      explicitReceiver = true;
      arguments_ =
        bound.arguments === undefined
          ? undefined
          : [...bound.arguments, ...(arguments_ ?? [])];
    }
    const method = path.length > 3 ? path.at(-1) : undefined;
    if (method === "call" || method === "apply") {
      // These properties hold generic function values. Their receiver selects
      // the callable; property-chain depth does not consume more arguments.
      const callable: t.Node | undefined = explicitReceiver
        ? receiver
        : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee.object
          : undefined;
      if (!t.isExpression(callable)) return undefined;
      callee = callable;
      receiver = arguments_?.[0];
      explicitReceiver = true;
      arguments_ = invocationArguments(method, arguments_);
      continue;
    }
    if (path.join(".") === "intrinsic.Reflect.apply") {
      const callable = arguments_?.[0];
      if (!t.isExpression(callable)) return undefined;
      callee = callable;
      receiver = arguments_?.[1];
      explicitReceiver = true;
      arguments_ = arrayArguments(arguments_?.[2]);
      continue;
    }
    return {
      kind: "known",
      path,
      arguments: arguments_,
      ...(receiver === undefined ? {} : { receiver }),
    };
  }
};
