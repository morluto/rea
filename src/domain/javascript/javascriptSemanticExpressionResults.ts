import * as t from "@babel/types";
import { syntaxEvaluationCannotThrow } from "./javascriptSymbolicControlFlow.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";

import {
  javaScriptExactResultOperand,
  unwrapJavaScriptExpression,
  semanticStaticPropertyKey,
  semanticFinalObjectMember,
} from "./javascriptAstValues.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

/** Compare a local binding event in its own lexical activation, without guessing callers. */
const lexicalFrame = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): SemanticExecutionFrame => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined || t.isFunction(parent) || t.isProgram(parent))
      return { owner: parent ?? current, point: node };
    current = parent;
  }
};

/** Local value reads and writable results share the same initialization event proof. */
const bindingInitializedBeforeRead = (
  binding: JavaScriptSemanticBindingState,
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  if (binding.runtimeImport) return false;
  if (
    binding.kind === "parameter" &&
    binding.definitionNodes.some((definition) => {
      const owner = state.parentsByNode.get(definition);
      if (!t.isFunction(owner)) return false;
      let current: t.Node | undefined = node;
      while (
        current !== undefined &&
        state.parentsByNode.get(current) !== owner
      )
        current = state.parentsByNode.get(current);
      return (
        t.isFunction(owner) &&
        owner.params.includes(definition as t.Identifier) &&
        current === owner.body &&
        (executionFrames?.(node) ?? [lexicalFrame(node, state)]).some(
          (frame) => frame.owner === owner,
        )
      );
    })
  )
    return true;
  if (
    binding.definitionNodes.some((definition) => {
      const declaration = state.parentsByNode.get(definition);
      return (
        t.isClassDeclaration(declaration) &&
        declaration.id === definition &&
        semanticInitializerPrecedesRead({
          initializer: declaration,
          read: node,
          bindingNode: definition,
          parents: state.parentsByNode,
          initializerContexts: executionFrames?.(declaration) ?? [
            lexicalFrame(declaration, state),
          ],
          readContexts: executionFrames?.(node) ?? [lexicalFrame(node, state)],
        }) === true
      );
    })
  )
    return true;
  if (binding.declarationKinds.has("var")) return true;
  if (
    binding.definitionNodes.some((definition) => {
      const owner = state.parentsByNode.get(definition);
      return t.isFunctionDeclaration(owner) && owner.id === definition;
    })
  )
    return true;
  if (
    ![...binding.declarationKinds].some((kind) =>
      ["let", "const", "using", "await using"].includes(kind),
    )
  )
    return false;
  return binding.definitionNodes.some((bindingNode) => {
    let declaration: t.Node | undefined = bindingNode;
    while (
      declaration !== undefined &&
      !t.isVariableDeclarator(declaration) &&
      !t.isFunction(declaration)
    )
      declaration = state.parentsByNode.get(declaration);
    return (
      t.isVariableDeclarator(declaration) &&
      semanticInitializerPrecedesRead({
        initializer: declaration,
        read: node,
        bindingNode,
        parents: state.parentsByNode,
        initializerContexts: executionFrames?.(declaration) ?? [
          lexicalFrame(declaration, state),
        ],
        readContexts: executionFrames?.(node) ?? [lexicalFrame(node, state)],
      }) === true
    );
  });
};

/** Both initial and replaced prototypes use the same fresh data-slot proof. */
const literalMemberWriteCanComplete = (
  object: t.Node,
  key: string,
  state: JavaScriptSemanticAnalysisState,
  depth = 0,
): boolean => {
  object = unwrapJavaScriptExpression(object).node;
  if (depth >= 128) return false;
  if (
    !t.isObjectExpression(object) ||
    !syntaxEvaluationCannotThrow(object) ||
    object.properties.some(
      (property) =>
        t.isSpreadElement(property) ||
        semanticStaticPropertyKey(property.key, property.computed) === null,
    )
  )
    return false;
  const member = semanticFinalObjectMember(object, key, "set");
  if (
    t.isObjectProperty(member) ||
    (t.isObjectMethod(member) && member.kind === "method")
  )
    return true;
  if (
    member !== undefined ||
    semanticFinalObjectMember(object, key, "get") !== undefined
  )
    return false;
  const prototype = object.properties.find(
    (property) =>
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      semanticStaticPropertyKey(property.key, false) === "__proto__",
  );
  return prototype === undefined
    ? !state.ambientWrites.covers(["global", "Object", "prototype", key]) &&
        !state.ambientEscapes.covers(["global", "Object", "prototype", key])
    : t.isObjectProperty(prototype) &&
        (t.isNullLiteral(prototype.value) ||
          literalMemberWriteCanComplete(
            prototype.value,
            key,
            state,
            depth + 1,
          ));
};

/** Completed collected effects, not just original literal syntax, own write validity. */
const memberAssignmentCanComplete = (
  target: t.MemberExpression,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  if (target.computed && !syntaxEvaluationCannotThrow(target.property))
    return false;
  const key = semanticStaticPropertyKey(target.property, target.computed);
  if (key === null || key === "__proto__") return false;
  const receiver = unwrapJavaScriptExpression(target.object).node;
  if (!t.isIdentifier(receiver))
    return literalMemberWriteCanComplete(receiver, key, state);
  state.memberMutationFactsPhase ??= "requested";
  if (state.memberMutationFactsPhase !== "indexed") return false;
  const binding = resolveSemanticBindingState(state, receiver, receiver.name);
  const initializer = semanticStableInitializer(binding, state);
  if (
    binding === undefined ||
    initializer === undefined ||
    initializer.projection.length !== 0 ||
    !binding.declarationKinds.has("const") ||
    binding.escapedPaths.length !== 0 ||
    !bindingInitializedBeforeRead(binding, read, state, executionFrames)
  )
    return false;
  if (!literalMemberWriteCanComplete(initializer.node, key, state))
    return false;
  const object = unwrapJavaScriptExpression(initializer.node).node;
  const own = t.isObjectExpression(object)
    ? semanticFinalObjectMember(object, key, "set")
    : undefined;
  const ownData =
    t.isObjectProperty(own) || (t.isObjectMethod(own) && own.kind === "method");
  return binding.memberWrites.every((effect) => {
    if (semanticEffectTiming(read, effect.node, state) === "after") return true;
    if (effect.path.length === 0 || effect.path[0] === null) return false;
    // Deletion can expose a prototype setter even when the original slot was data.
    if (
      ownData &&
      effect.path.length === 1 &&
      effect.path[0] === key &&
      t.isUnaryExpression(effect.node, { operator: "delete" })
    )
      return false;
    if (effect.path[0] !== "__proto__") return true;
    if (ownData) return true;
    const mutation = effect.node;
    if (
      effect.path.length !== 1 ||
      !t.isAssignmentExpression(mutation, { operator: "=" })
    )
      return false;
    return (
      t.isNullLiteral(mutation.right) ||
      literalMemberWriteCanComplete(mutation.right, key, state)
    );
  });
};

/** Assignment result and pattern progress use the same completed target proof. */
export const semanticAssignmentTargetCompletion = (
  targetNode: t.Node,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): "completed" | "abrupt" | "unknown" => {
  const target = unwrapJavaScriptExpression(targetNode).node;
  if (t.isMemberExpression(target))
    return memberAssignmentCanComplete(target, read, state, executionFrames)
      ? "completed"
      : "unknown";
  if (!t.isIdentifier(target)) return "unknown";
  const binding = resolveSemanticBindingState(state, target, target.name);
  if (binding === undefined) return "unknown";
  if (
    binding.runtimeImport ||
    [...binding.declarationKinds].some(
      (kind) => kind === "const" || kind === "using" || kind === "await using",
    )
  )
    return "abrupt";
  return bindingInitializedBeforeRead(binding, read, state, executionFrames)
    ? "completed"
    : "unknown";
};

/** Nonthrowing reads require binding initialization, not merely a known value. */
export const semanticExpressionCannotThrow = (
  rawNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
  depth = 0,
): boolean => {
  if (depth >= 128) return false;
  const node = unwrapJavaScriptExpression(rawNode).node;
  if (syntaxEvaluationCannotThrow(node)) return true;
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    return (
      binding !== undefined &&
      bindingInitializedBeforeRead(binding, node, state, executionFrames)
    );
  }
  if (t.isConditionalExpression(node))
    return [node.test, node.consequent, node.alternate].every((operand) =>
      semanticExpressionCannotThrow(operand, state, executionFrames, depth + 1),
    );
  return (
    t.isAssignmentExpression(node) &&
    node.operator === "=" &&
    semanticAssignmentTargetCompletion(
      node.left,
      node,
      state,
      executionFrames,
    ) === "completed" &&
    semanticExpressionCannotThrow(node.right, state, executionFrames, depth + 1)
  );
};

/** Value identity follows assignment RHS only after its target write can complete. */
export const semanticExactResultOperand = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): t.Node | undefined => {
  const selected = unwrapJavaScriptExpression(node).node;
  if (
    t.isSequenceExpression(selected) &&
    !selected.expressions
      .slice(0, -1)
      .every((prefix) =>
        semanticExpressionCannotThrow(prefix, state, executionFrames),
      )
  )
    return undefined;
  return javaScriptExactResultOperand(
    node,
    (assignment) =>
      semanticAssignmentTargetCompletion(
        assignment.left,
        assignment,
        state,
        executionFrames,
      ) === "completed",
    syntaxEvaluationCannotThrow,
  );
};
