import * as t from "@babel/types";
import {
  readExactJavaScriptNormalResult,
  semanticDirectFunctionReturn,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  syntaxEvaluationAlwaysThrows,
  syntaxAlwaysThrows,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";

export type JavaScriptResourceAcquisition = "acquired" | "failed" | "unknown";

interface AsyncResourceRegistration {
  readonly status: JavaScriptResourceAcquisition;
  readonly disposer?: t.Function;
  readonly synchronous?: boolean;
}

/** Registration captures a callable disposer; evaluating an object is not registration. */
const asyncResourceRegistration = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
): AsyncResourceRegistration => {
  if (syntaxEvaluationAlwaysThrows(raw)) return { status: "failed" };
  const node = unwrapJavaScriptExpression(raw).node;
  const normal = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (normal.found)
    return { status: normal.value == null ? "acquired" : "failed" };
  if (isUnshadowedGlobal(node, state, "undefined"))
    return { status: "acquired" };
  if (t.isBigIntLiteral(node)) return { status: "failed" };
  if (!t.isObjectExpression(node)) return { status: "unknown" };
  // These proofs depend on collected intrinsic/prototype effects. An index
  // still being produced is not proof that the relevant effects are absent.
  state.memberMutationFactsPhase ??= "requested";
  if (state.memberMutationFactsPhase !== "indexed")
    return { status: "unknown" };
  let prototype: "default" | "null" | "unknown" = "default";
  const disposers = new Map<string, (t.ObjectProperty | t.ObjectMethod)[]>();
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) return { status: "unknown" };
    const key = unwrapJavaScriptExpression(property.key).node;
    const symbol =
      property.computed &&
      t.isMemberExpression(key) &&
      !key.computed &&
      t.isIdentifier(key.property) &&
      ["asyncDispose", "dispose"].includes(key.property.name) &&
      isUnshadowedGlobal(key.object, state, "Symbol") &&
      !state.ambientWrites.covers(["global", "Symbol", key.property.name]) &&
      !state.ambientEscapes.covers(["global", "Symbol", key.property.name]);
    if (
      !symbol &&
      (semanticStaticPropertyKey(key, property.computed) === null ||
        (property.computed && !syntaxEvaluationCannotThrow(key)))
    )
      return { status: "unknown" };
    if (
      t.isObjectProperty(property) &&
      !syntaxEvaluationCannotThrow(property.value)
    )
      return { status: "unknown" };
    if (symbol && t.isMemberExpression(key) && t.isIdentifier(key.property))
      disposers.set(key.property.name, [
        ...(disposers.get(key.property.name) ?? []),
        property,
      ]);
    if (
      !property.computed &&
      t.isObjectProperty(property) &&
      !property.shorthand &&
      semanticStaticPropertyKey(key, false) === "__proto__"
    )
      prototype = t.isNullLiteral(property.value) ? "null" : "unknown";
  }
  const inheritedUnknown =
    prototype === "unknown" ||
    (prototype === "default" &&
      (state.ambientWrites.covers(["global", "Object", "prototype", null]) ||
        state.ambientEscapes.covers(["global", "Object", "prototype", null])));
  for (const name of ["asyncDispose", "dispose"]) {
    const members = disposers.get(name) ?? [];
    let accessor = false;
    let method: t.ObjectProperty | t.ObjectMethod | undefined;
    for (const member of members.toReversed()) {
      if (t.isObjectMethod(member, { kind: "set" })) {
        accessor = true;
        continue;
      }
      if (!accessor || (t.isObjectMethod(member) && member.kind === "get"))
        method = member;
      break;
    }
    if (method === undefined) {
      // A setter-only own descriptor reads as undefined and shadows the
      // prototype. It therefore falls through to Symbol.dispose.
      if (accessor) continue;
      if (inheritedUnknown) return { status: "unknown" };
      continue;
    }
    if (t.isObjectMethod(method))
      return method.kind === "method"
        ? {
            status: "acquired",
            disposer: method,
            synchronous: name === "dispose",
          }
        : { status: "unknown" };
    const value = unwrapJavaScriptExpression(method.value).node;
    if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
      return {
        status: "acquired",
        disposer: value,
        synchronous: name === "dispose",
      };
    const result = readExactJavaScriptNormalResult(
      value,
      syntaxEvaluationCannotThrow,
    );
    if (!result.found) return { status: "unknown" };
    if (result.value != null) return { status: "failed" };
  }
  return { status: "failed" };
};

/** Acquiring a method and reaching its disposal await are separate facts. */
const asyncResourceDisposal = (
  registration: AsyncResourceRegistration,
): "wait" | "abrupt" | "unknown" => {
  if (registration.status !== "acquired")
    return registration.status === "failed" ? "abrupt" : "unknown";
  const method = registration.disposer;
  // Async-from-sync disposal catches a synchronous failure into a rejected
  // promise; a directly registered asyncDispose method can throw before await.
  if (
    method === undefined ||
    registration.synchronous ||
    (method.async && !method.generator)
  )
    return "wait";
  // Ordinary and generator methods initialize parameters during Call, before
  // producing a value to await. Non-generator async methods reject a promise.
  if (
    method.params.some(
      (parameter) =>
        t.isObjectPattern(parameter) ||
        t.isArrayPattern(parameter) ||
        (t.isAssignmentPattern(parameter) &&
          syntaxEvaluationAlwaysThrows(parameter.right)),
    )
  )
    return "abrupt";
  if (
    !method.params.every(
      (parameter) =>
        t.isIdentifier(parameter) ||
        (t.isRestElement(parameter) && t.isIdentifier(parameter.argument)) ||
        (t.isAssignmentPattern(parameter) &&
          t.isIdentifier(parameter.left) &&
          syntaxEvaluationCannotThrow(parameter.right)),
    )
  )
    return "unknown";
  if (method.generator) return "wait";
  if (syntaxAlwaysThrows(method.body)) return "abrupt";
  const returned = semanticDirectFunctionReturn(method);
  return syntaxEvaluationCannotThrow(method.body) ||
    (t.isBlockStatement(method.body) &&
      method.body.body.every((statement) =>
        t.isReturnStatement(statement)
          ? statement.argument == null ||
            syntaxEvaluationCannotThrow(statement.argument)
          : syntaxEvaluationCannotThrow(statement),
      )) ||
    (returned !== undefined && syntaxEvaluationCannotThrow(returned))
    ? "wait"
    : "unknown";
};

interface AsyncDeclarationFacts {
  readonly acquisition: JavaScriptResourceAcquisition;
  readonly completion: "completed" | "failed" | "unknown";
  readonly disposal: "wait" | "abrupt" | "unknown";
}

/** Registration is ordered; disposal visits all reached resources in reverse. */
export const semanticAsyncDeclarationFacts = (
  declaration: t.VariableDeclaration,
  state: JavaScriptSemanticAnalysisState,
): AsyncDeclarationFacts => {
  const reached: AsyncResourceRegistration[] = [];
  let completion: AsyncDeclarationFacts["completion"] = "completed";
  for (const declarator of declaration.declarations) {
    const registration =
      declarator.init == null
        ? { status: "unknown" as const }
        : asyncResourceRegistration(declarator.init, state);
    if (registration.status !== "acquired") {
      completion = registration.status;
      break;
    }
    reached.push(registration);
  }
  let disposal: AsyncDeclarationFacts["disposal"] =
    completion === "unknown" ? "unknown" : "abrupt";
  for (const registration of reached.toReversed()) {
    const next = asyncResourceDisposal(registration);
    // DisposeResources continues after an abrupt disposer; an earlier or later
    // guaranteed wait is not erased by another resource's synchronous failure.
    if (next === "wait") {
      disposal = "wait";
      break;
    }
    if (next === "unknown") disposal = "unknown";
  }
  return {
    acquisition:
      reached.length > 0
        ? "acquired"
        : completion === "failed"
          ? "failed"
          : "unknown",
    completion,
    disposal,
  };
};
