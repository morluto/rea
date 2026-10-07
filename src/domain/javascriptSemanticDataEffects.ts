import * as t from "@babel/types";

import { semanticBuiltinNamespacePath } from "./javascriptSemanticProvenance.js";

import type {
  JavaScriptSemanticBoundaryOperation,
  JavaScriptSemanticCallable,
  JavaScriptSemanticConfigurationOperation,
  JavaScriptSemanticRequestOperation,
} from "./javascriptSemanticIr.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { semanticStaticPropertyName } from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  builtinDataEffectMethod as builtinMethod,
  containsSemanticNode as containsNode,
  dataEffectArgumentBindingId as argumentBindingId,
  dataEffectLiteralString as literalString,
  dataEffectMemberCallee as memberCallee,
  dataEffectMemberObject as memberObject,
  dataEffectPrimitive as primitiveValue,
  isSemanticProcessObject as isProcessObject,
  outerDataEffectBinding as outerAssignedBinding,
  assignedSemanticResultBindings,
  semanticProjectedBindingFacts,
  traverseDataEffects as traverseWithContext,
  type DataEffectTraversalContext as TraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

interface DataEffectAnalysis {
  readonly configurationOperations: readonly JavaScriptSemanticConfigurationOperation[];
  readonly requestOperations: readonly JavaScriptSemanticRequestOperation[];
  readonly boundaryOperations: readonly JavaScriptSemanticBoundaryOperation[];
}

interface ConfigurationCandidate {
  readonly node: t.Node;
  readonly operation: JavaScriptSemanticConfigurationOperation;
}

interface RequestCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression | t.NewExpression;
  readonly operation: JavaScriptSemanticRequestOperation;
}

/** Recover configuration, request, and boundary candidates from inert syntax. */
export const collectJavaScriptSemanticDataEffects = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): DataEffectAnalysis => {
  const context: TraversalContext = {
    state,
    callableIds: new Set(callables.map(({ callableId }) => callableId)),
    callableStack: [],
    ancestors: [],
  };
  const configuration = collectConfigurations(program, context);
  const requests = collectRequests(program, context);
  return {
    configurationOperations: [
      ...configuration.map(({ operation }) => operation),
      ...collectDefaults(program, context, configuration),
    ],
    requestOperations: [
      ...requests.map(({ operation }) => operation),
      ...collectResponseConsumers(program, context, requests),
    ],
    boundaryOperations: collectBoundaries(program, context),
  };
};

const collectConfigurations = (
  program: t.Program,
  context: TraversalContext,
): ConfigurationCandidate[] => {
  const output: ConfigurationCandidate[] = [];
  traverseWithContext(program, context, (node, parent) => {
    const details = configurationDetails(node, parent, context);
    if (details === null) return;
    const operation: JavaScriptSemanticConfigurationOperation = {
      configId: `config:${details.kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: details.kind,
      location: range(node),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: outerAssignedBinding(node, context),
      key: details.key,
      sourceConfigId: null,
      value: null,
      resolution: details.resolution,
    };
    output.push({ node, operation });
  });
  return output;
};

const configurationDetails = (
  node: t.Node,
  parent: t.Node | null,
  context: TraversalContext,
): {
  readonly kind: "environment" | "argv" | "file";
  readonly key: string | null;
  readonly resolution: "complete" | "partial";
} | null => {
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !(memberObject(parent) === node)
  ) {
    const processMember = processConfigurationMember(node, context.state);
    if (processMember !== null) return processMember;
  }
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return null;
  const fileMethod = builtinMethod(node.callee, context.state, [
    "fs",
    "node:fs",
  ]);
  return fileMethod === "readFile" || fileMethod === "readFileSync"
    ? {
        kind: "file",
        key: literalString(node.arguments[0]),
        resolution:
          literalString(node.arguments[0]) === null ? "partial" : "complete",
      }
    : null;
};

const processConfigurationMember = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly kind: "environment" | "argv";
  readonly key: string | null;
  readonly resolution: "complete" | "partial";
} | null => {
  const object = node.object;
  if (!t.isMemberExpression(object) && !t.isOptionalMemberExpression(object))
    return null;
  if (!isProcessObject(object.object, state)) return null;
  const family = semanticStaticPropertyName(object.property, object.computed);
  if (family !== "env" && family !== "argv") return null;
  const key = semanticStaticPropertyName(node.property, node.computed) || null;
  return {
    kind: family === "env" ? "environment" : "argv",
    key,
    resolution: key === null ? "partial" : "complete",
  };
};

const collectDefaults = (
  program: t.Program,
  context: TraversalContext,
  configurations: readonly ConfigurationCandidate[],
): JavaScriptSemanticConfigurationOperation[] => {
  const output: JavaScriptSemanticConfigurationOperation[] = [];
  traverseWithContext(program, context, (node) => {
    if (
      !t.isLogicalExpression(node) ||
      (node.operator !== "??" && node.operator !== "||")
    )
      return;
    const sources = configurations.filter(({ node: source }) =>
      containsNode(node.left, source),
    );
    if (sources.length !== 1 || sources[0] === undefined) return;
    output.push({
      configId: `config:default:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: "default",
      location: range(node.right),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: outerAssignedBinding(node, context),
      key: sources[0].operation.key,
      sourceConfigId: sources[0].operation.configId,
      value: primitiveValue(node.right),
      resolution: primitiveValue(node.right) === null ? "partial" : "complete",
    });
  });
  return output;
};

const collectRequests = (
  program: t.Program,
  context: TraversalContext,
): RequestCandidate[] => {
  const output: RequestCandidate[] = [];
  traverseWithContext(program, context, (node) => {
    if (
      !t.isCallExpression(node) &&
      !t.isOptionalCallExpression(node) &&
      !t.isNewExpression(node)
    )
      return;
    const method = requestMethod(node, context.state);
    if (method === null) return;
    const endpoint = requestEndpoint(node);
    output.push({
      node,
      operation: {
        requestId: `request:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
        kind: "request",
        method,
        location: range(node),
        ownerCallableId: context.callableStack.at(-1) ?? null,
        resultBindingId: outerAssignedBinding(node, context),
        projectedResultBindings: semanticProjectedBindingFacts(
          assignedSemanticResultBindings(
            node,
            context.ancestors,
            context.state,
          ).filter(({ projectionPath }) => projectionPath.length > 0),
        ),
        linkedRequestIds: [],
        endpoint,
        fields: requestFields(node, method, context.state),
        resolution: endpoint === null ? "partial" : "complete",
      },
    });
  });
  return output;
};

const collectResponseConsumers = (
  program: t.Program,
  context: TraversalContext,
  requests: readonly RequestCandidate[],
): JavaScriptSemanticRequestOperation[] => {
  const requestsByBinding = new Map<string, RequestCandidate[]>();
  for (const request of requests) {
    const bindingIds = [
      ...(request.operation.resultBindingId === null
        ? []
        : [request.operation.resultBindingId]),
      ...request.operation.projectedResultBindings.map(
        ({ bindingId }) => bindingId,
      ),
    ];
    for (const bindingId of bindingIds) {
      const existing = requestsByBinding.get(bindingId) ?? [];
      existing.push(request);
      requestsByBinding.set(bindingId, existing);
    }
  }
  const output: JavaScriptSemanticRequestOperation[] = [];
  traverseWithContext(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const member = memberCallee(node);
    if (member === null || !t.isIdentifier(member.object)) return;
    const method = semanticStaticPropertyName(member.property, member.computed);
    if (method !== "json" && method !== "text" && method !== "arrayBuffer")
      return;
    const binding = resolveSemanticBindingState(
      context.state,
      member.object,
      member.object.name,
    );
    const linked =
      binding === undefined
        ? []
        : (requestsByBinding.get(binding.bindingId) ?? []);
    if (linked.length === 0) return;
    output.push({
      requestId: `response:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: "response-consumer",
      method,
      location: range(node),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: outerAssignedBinding(node, context),
      projectedResultBindings: semanticProjectedBindingFacts(
        assignedSemanticResultBindings(
          node,
          context.ancestors,
          context.state,
        ).filter(({ projectionPath }) => projectionPath.length > 0),
      ),
      linkedRequestIds: linked
        .map(({ operation }) => operation.requestId)
        .sort(compareCodePoints),
      endpoint: null,
      fields: [],
      resolution:
        linked.length === 1 &&
        !linked[0]?.operation.projectedResultBindings.some(
          ({ bindingId }) => bindingId === binding?.bindingId,
        )
          ? "complete"
          : "partial",
    });
  });
  return output;
};

const collectBoundaries = (
  program: t.Program,
  context: TraversalContext,
): JavaScriptSemanticBoundaryOperation[] => {
  const output: JavaScriptSemanticBoundaryOperation[] = [];
  traverseWithContext(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const details = boundaryDetails(node, context.state);
    if (details === null) return;
    output.push({
      boundaryId: `boundary:${details.kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: details.kind,
      method: details.method,
      location: range(node),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      sourceBindingId: argumentBindingId(node.arguments[0], context.state),
      resultBindingId: outerAssignedBinding(node, context),
      resolution: details.resolution,
    });
  });
  return output;
};

const boundaryDetails = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly kind: JavaScriptSemanticBoundaryOperation["kind"];
  readonly method: string;
  readonly resolution: "complete" | "partial";
} | null => {
  if (t.isIdentifier(node.callee)) {
    const name = node.callee.name;
    const unbound =
      resolveSemanticBindingState(state, node.callee, name) === undefined &&
      !semanticResolutionBlocked(state, node.callee, name);
    if (
      unbound &&
      ["String", "Number", "Boolean", "parseInt", "parseFloat"].includes(name)
    )
      return { kind: "coerce", method: name, resolution: "complete" };
  }
  const member = memberCallee(node);
  if (member === null) return null;
  const method = semanticStaticPropertyName(member.property, member.computed);
  if (
    method === "parse" &&
    t.isIdentifier(member.object, { name: "JSON" }) &&
    resolveSemanticBindingState(state, member.object, "JSON") === undefined &&
    !semanticResolutionBlocked(state, member.object, "JSON")
  )
    return { kind: "parse", method: "JSON.parse", resolution: "complete" };
  if (method === "parse" || method === "safeParse")
    return { kind: "parse", method, resolution: "partial" };
  if (method === "validate" || method === "assert" || method === "is")
    return { kind: "validate", method, resolution: "partial" };
  return null;
};

const requestMethod = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticRequestOperation["method"] | null => {
  if (t.isIdentifier(node.callee)) {
    const name = node.callee.name;
    const unbound =
      resolveSemanticBindingState(state, node.callee, name) === undefined &&
      !semanticResolutionBlocked(state, node.callee, name);
    if (!t.isNewExpression(node) && unbound && name === "fetch") return "fetch";
    if (t.isNewExpression(node) && unbound && name === "WebSocket")
      return "WebSocket";
  }
  const member = memberCallee(node);
  if (member === null || !t.isIdentifier(member.object)) return null;
  const method = semanticStaticPropertyName(member.property, member.computed);
  if (method !== "request" && method !== "get") return null;
  const binding = resolveSemanticBindingState(
    state,
    member.object,
    member.object.name,
  );
  return binding?.directOrigins.some(
    ({ specifier, importedPath }) =>
      ["http", "https", "node:http", "node:https"].includes(specifier) &&
      semanticBuiltinNamespacePath(importedPath),
  )
    ? method
    : null;
};

const requestFields = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  method: JavaScriptSemanticRequestOperation["method"],
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticRequestOperation["fields"] => {
  const candidate =
    method === "fetch" || method === "WebSocket"
      ? node.arguments[1]
      : t.isObjectExpression(node.arguments[0])
        ? node.arguments[0]
        : node.arguments[1];
  if (!t.isObjectExpression(candidate)) return [];
  return candidate.properties.flatMap((property) => {
    if (!t.isObjectProperty(property)) return [];
    // `{[key]: 1}` sends no knowable field name; reporting `key` would invent
    // a request field that may not exist.
    const name = semanticStaticPropertyName(property.key, property.computed);
    if (name.length === 0) return [];
    return [
      {
        name,
        sourceBindingId: t.isIdentifier(property.value)
          ? (resolveSemanticBindingState(
              state,
              property.value,
              property.value.name,
            )?.bindingId ?? null)
          : null,
      },
    ];
  });
};

const requestEndpoint = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): string | null =>
  t.isObjectExpression(node.arguments[0])
    ? null
    : literalString(node.arguments[0]);
