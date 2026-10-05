import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticChildProcessInteraction,
  JavaScriptSemanticChildProcessSpawn,
} from "./javascriptSemanticIr.js";
import {
  semanticCallableIdForNode,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  dataEffectLiteralString,
  dataEffectMemberCallee,
  assignedSemanticResultBindings,
  scalarAssignedResultBinding,
  semanticProjectedBindingFacts,
} from "./javascriptSemanticDataEffectHelpers.js";

const CHILD_PROCESS_METHODS = ["spawn", "exec", "execFile", "fork"] as const;
const CHILD_LISTENER_METHODS = ["on", "once", "addListener"] as const;

interface ChildProcessAnalysis {
  readonly childProcessSpawns: readonly JavaScriptSemanticChildProcessSpawn[];
  readonly childProcessInteractions: readonly JavaScriptSemanticChildProcessInteraction[];
}

interface SpawnCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly method: JavaScriptSemanticChildProcessSpawn["method"];
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly projectedResultBindings: readonly {
    readonly bindingId: string;
    readonly projectionPath: readonly (string | number | null)[];
    readonly resolution: "complete" | "partial";
  }[];
}

interface ChildInteractionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly spawnByNode: WeakMap<t.Node, SpawnCandidate>;
  readonly spawnsByBinding: ReadonlyMap<string, readonly SpawnCandidate[]>;
}

/** Recover explicit asynchronous node:child_process ownership candidates. */
export const collectJavaScriptSemanticChildProcesses = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): ChildProcessAnalysis => {
  const candidates = collectSpawns(program, state, callables);
  const childProcessSpawns = candidates.map((candidate) =>
    immutableSpawn(candidate),
  );
  return {
    childProcessSpawns,
    childProcessInteractions: collectInteractions(
      program,
      state,
      callables,
      candidates,
    ),
  };
};

const collectSpawns = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): SpawnCandidate[] => {
  const output: SpawnCandidate[] = [];
  const admittedCallables = new Set(
    callables.map(({ callableId }) => callableId),
  );
  const callableStack: string[] = [];
  const ancestors: t.Node[] = [];
  traverseJavaScriptAst(program, {
    enter: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && admittedCallables.has(callableId))
        callableStack.push(callableId);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const method = childProcessMethod(node.callee, state);
        if (method !== null) {
          const projectedResultBindings = assignedSemanticResultBindings(
            node,
            ancestors,
            state,
          );
          output.push({
            node,
            method,
            ownerCallableId: callableStack.at(-1) ?? null,
            resultBindingId: scalarAssignedResultBinding(
              projectedResultBindings,
            ),
            projectedResultBindings: semanticProjectedBindingFacts(
              projectedResultBindings.filter(
                ({ projectionPath }) => projectionPath.length > 0,
              ),
            ),
          });
        }
      }
      ancestors.push(node);
    },
    exit: (node) => {
      ancestors.pop();
      popCallable(node, callableStack);
    },
  });
  return output;
};

const immutableSpawn = (
  candidate: SpawnCandidate,
): JavaScriptSemanticChildProcessSpawn => {
  const options = spawnOptions(candidate);
  const command = dataEffectLiteralString(candidate.node.arguments[0]);
  return {
    processId: spawnId(candidate),
    method: candidate.method,
    location: range(candidate.node),
    ownerCallableId: candidate.ownerCallableId,
    resultBindingId: candidate.resultBindingId,
    projectedResultBindings: candidate.projectedResultBindings,
    command,
    argvCount: spawnArgvCount(candidate),
    environmentSupplied: objectHasProperty(options, "env"),
    stdioMode: stdioMode(options),
    resolution: command === null ? "partial" : "complete",
  };
};

const collectInteractions = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
  spawns: readonly SpawnCandidate[],
): JavaScriptSemanticChildProcessInteraction[] => {
  const output: JavaScriptSemanticChildProcessInteraction[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack: string[] = [];
  const spawnByNode = new WeakMap<t.Node, SpawnCandidate>();
  const spawnsByBinding = new Map<string, SpawnCandidate[]>();
  for (const spawn of spawns) {
    spawnByNode.set(spawn.node, spawn);
    const ids = [
      ...(spawn.resultBindingId === null ? [] : [spawn.resultBindingId]),
      ...spawn.projectedResultBindings.map(({ bindingId }) => bindingId),
    ];
    for (const id of ids) {
      const existing = spawnsByBinding.get(id) ?? [];
      existing.push(spawn);
      spawnsByBinding.set(id, existing);
    }
  }
  const context: ChildInteractionContext = {
    state,
    spawnByNode,
    spawnsByBinding,
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && callableIds.has(callableId))
        callableStack.push(callableId);
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return;
      const interaction = childInteraction(
        node,
        callableStack.at(-1) ?? null,
        context,
      );
      if (interaction === null) return;
      output.push(interaction);
    },
    exit: (node) => popCallable(node, callableStack),
  });
  return output;
};

const childInteraction = (
  node: t.CallExpression | t.OptionalCallExpression,
  ownerCallableId: string | null,
  context: ChildInteractionContext,
): JavaScriptSemanticChildProcessInteraction | null => {
  const { state, spawnByNode, spawnsByBinding } = context;
  const member = dataEffectMemberCallee(node);
  if (member === null) return null;
  const method = semanticStaticPropertyName(member.property, member.computed);
  const binding = objectBinding(member.object, state);
  const linked = resolveChildCandidates(
    member.object,
    binding,
    spawnByNode,
    spawnsByBinding,
  );
  if (linked.length === 0) return null;
  const classification = classifyInteraction(method, node.arguments[0]);
  if (classification === null) return null;
  const { kind, interactionMethod, eventName } = classification;
  const listener = node.arguments[1];
  return {
    interactionId: `child:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
    kind,
    method: interactionMethod,
    location: range(node),
    ownerCallableId,
    processBindingId: binding?.bindingId ?? null,
    linkedProcessIds: linked
      .map((candidate) => spawnId(candidate))
      .sort(compareCodePoints),
    eventName: kind === "listener" ? eventName : null,
    signalName:
      kind === "signal"
        ? (dataEffectLiteralString(node.arguments[0]) ?? "SIGTERM")
        : null,
    listenerLocation:
      kind === "listener" && t.isNode(listener) ? range(listener) : null,
    resolution:
      linked.length === 1 &&
      !linked[0]?.projectedResultBindings.some(
        ({ bindingId }) => bindingId === binding?.bindingId,
      )
        ? "complete"
        : "partial",
  };
};

const classifyInteraction = (
  method: string,
  argument:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
): {
  readonly kind: JavaScriptSemanticChildProcessInteraction["kind"];
  readonly interactionMethod: JavaScriptSemanticChildProcessInteraction["method"];
  readonly eventName: "exit" | "error" | null;
} | null => {
  if (method === "kill")
    return { kind: "signal", interactionMethod: "kill", eventName: null };
  const listenerMethod = CHILD_LISTENER_METHODS.find(
    (candidate) => candidate === method,
  );
  const eventName = dataEffectLiteralString(argument);
  return listenerMethod !== undefined &&
    (eventName === "exit" || eventName === "error")
    ? { kind: "listener", interactionMethod: listenerMethod, eventName }
    : null;
};

const childProcessMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticChildProcessSpawn["method"] | null => {
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    return binding === undefined ? null : methodFromBinding(binding);
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return null;
  const method = admittedChildMethod(
    semanticStaticPropertyName(callee.property, callee.computed),
  );
  if (method === null || !t.isIdentifier(callee.object)) return null;
  const binding = resolveSemanticBindingState(
    state,
    callee.object,
    callee.object.name,
  );
  return childProcessNamespace(binding) ? method : null;
};

const methodFromBinding = (
  binding: JavaScriptSemanticBindingState,
): JavaScriptSemanticChildProcessSpawn["method"] | null => {
  for (const { specifier, importedPath } of binding.directOrigins) {
    if (!childProcessModule(specifier)) continue;
    const method = admittedChildMethod(importedPath.at(-1) ?? "");
    if (method !== null) return method;
  }
  return null;
};

const admittedChildMethod = (
  value: string,
): JavaScriptSemanticChildProcessSpawn["method"] | null =>
  CHILD_PROCESS_METHODS.find((candidate) => candidate === value) ?? null;

const childProcessNamespace = (
  binding: JavaScriptSemanticBindingState | undefined,
): boolean =>
  binding?.directOrigins.some(
    ({ specifier, importedPath }) =>
      childProcessModule(specifier) && importedPath.length === 0,
  ) ?? false;

const childProcessModule = (specifier: string): boolean =>
  specifier === "child_process" || specifier === "node:child_process";

const resolveChildCandidates = (
  node: t.Node,
  binding: JavaScriptSemanticBindingState | undefined,
  spawnByNode: WeakMap<t.Node, SpawnCandidate>,
  spawnsByBinding: ReadonlyMap<string, readonly SpawnCandidate[]>,
): readonly SpawnCandidate[] => {
  const direct = spawnByNode.get(node);
  if (direct !== undefined) return [direct];
  return binding === undefined
    ? []
    : (spawnsByBinding.get(binding.bindingId) ?? []);
};

const spawnOptions = (candidate: SpawnCandidate): t.ObjectExpression | null => {
  const index = candidate.method === "exec" ? 1 : 2;
  const value = candidate.node.arguments[index];
  return t.isObjectExpression(value) ? value : null;
};

const spawnArgvCount = (candidate: SpawnCandidate): number | null => {
  if (candidate.method === "exec") return null;
  const args = candidate.node.arguments[1];
  return t.isArrayExpression(args) ? args.elements.length : null;
};

const objectHasProperty = (
  object: t.ObjectExpression | null,
  name: string,
): boolean => objectProperty(object, name) !== null;

const stdioMode = (options: t.ObjectExpression | null): string => {
  const property = objectProperty(options, "stdio");
  if (property === null || !t.isObjectProperty(property)) return "default";
  if (t.isStringLiteral(property.value)) return property.value.value;
  if (t.isArrayExpression(property.value)) return "array";
  return "dynamic";
};

const objectProperty = (
  object: t.ObjectExpression | null,
  name: string,
): t.ObjectMethod | t.ObjectProperty | null =>
  object?.properties.find(
    (property): property is t.ObjectMethod | t.ObjectProperty =>
      (t.isObjectMethod(property) || t.isObjectProperty(property)) &&
      // `{[env]: vars}` has a dynamic key; treating it as `env` would claim
      // the caller supplied an environment when the real key is unknown.
      semanticStaticPropertyName(property.key, property.computed) === name,
  ) ?? null;

const objectBinding = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined =>
  t.isIdentifier(node)
    ? resolveSemanticBindingState(state, node, node.name)
    : undefined;

const popCallable = (node: t.Node, stack: string[]): void => {
  const callableId = semanticCallableIdForNode(node);
  if (callableId !== null && stack.at(-1) === callableId) stack.pop();
};

const spawnId = (candidate: SpawnCandidate): string =>
  `child:spawn:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;
