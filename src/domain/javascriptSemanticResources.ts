import { semanticBuiltinNamespacePath } from "./javascriptSemanticProvenance.js";
import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticResourceOperation,
} from "./javascriptSemanticIr.js";
import { semanticStaticPropertyName } from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  dataEffectMemberCallee,
  outerDataEffectBinding,
  traverseDataEffects,
  type DataEffectTraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

const ACQUIRE_METHODS = [
  "open",
  "openSync",
  "createReadStream",
  "createWriteStream",
  "connect",
  "createConnection",
] as const;
const RELEASE_METHODS = ["close", "destroy", "end"] as const;

interface ResourceCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly method: JavaScriptSemanticResourceOperation["method"];
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
}

/** Recover built-in filesystem/network acquisition and local release handles. */
export const collectJavaScriptSemanticResources = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticResourceOperation[] => {
  const context: DataEffectTraversalContext = {
    state,
    callableIds: new Set(callables.map(({ callableId }) => callableId)),
    callableStack: [],
    ancestors: [],
  };
  const acquisitions = collectAcquisitions(program, context);
  return [
    ...acquisitions.map(immutableAcquisition),
    ...collectReleases(program, context, acquisitions),
  ];
};

const collectAcquisitions = (
  program: t.Program,
  context: DataEffectTraversalContext,
): ResourceCandidate[] => {
  const output: ResourceCandidate[] = [];
  traverseDataEffects(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const method = acquisitionMethod(node.callee, context.state);
    if (method === null) return;
    output.push({
      node,
      method,
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: outerDataEffectBinding(node, context),
    });
  });
  return output;
};

const collectReleases = (
  program: t.Program,
  context: DataEffectTraversalContext,
  acquisitions: readonly ResourceCandidate[],
): JavaScriptSemanticResourceOperation[] => {
  const byBinding = new Map<string, ResourceCandidate[]>();
  for (const acquisition of acquisitions) {
    if (acquisition.resultBindingId === null) continue;
    const existing = byBinding.get(acquisition.resultBindingId) ?? [];
    existing.push(acquisition);
    byBinding.set(acquisition.resultBindingId, existing);
  }
  const output: JavaScriptSemanticResourceOperation[] = [];
  traverseDataEffects(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const member = dataEffectMemberCallee(node);
    if (member === null || !t.isIdentifier(member.object)) return;
    const method = RELEASE_METHODS.find(
      (candidate) =>
        candidate ===
        semanticStaticPropertyName(member.property, member.computed),
    );
    if (method === undefined) return;
    const binding = resolveSemanticBindingState(
      context.state,
      member.object,
      member.object.name,
    );
    const linked =
      binding === undefined ? [] : (byBinding.get(binding.bindingId) ?? []);
    if (linked.length === 0) return;
    output.push({
      resourceId: `resource:release:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: "release",
      method,
      location: range(node),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: binding?.bindingId ?? null,
      linkedResourceIds: linked.map(resourceCandidateId).sort(),
      resolution: linked.length === 1 ? "complete" : "partial",
    });
  });
  return output;
};

const immutableAcquisition = (
  candidate: ResourceCandidate,
): JavaScriptSemanticResourceOperation => ({
  resourceId: resourceCandidateId(candidate),
  kind: "acquire",
  method: candidate.method,
  location: range(candidate.node),
  ownerCallableId: candidate.ownerCallableId,
  resultBindingId: candidate.resultBindingId,
  linkedResourceIds: [],
  resolution: "complete",
});

const acquisitionMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticResourceOperation["method"] | null => {
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    return methodFromBinding(binding);
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return null;
  const method = ACQUIRE_METHODS.find(
    (candidate) =>
      candidate ===
      semanticStaticPropertyName(callee.property, callee.computed),
  );
  if (method === undefined || !t.isIdentifier(callee.object)) return null;
  const binding = resolveSemanticBindingState(
    state,
    callee.object,
    callee.object.name,
  );
  return resourceNamespace(binding) ? method : null;
};

const methodFromBinding = (
  binding: JavaScriptSemanticBindingState | undefined,
): JavaScriptSemanticResourceOperation["method"] | null => {
  for (const { specifier, importedPath } of binding?.directOrigins ?? []) {
    if (!resourceModule(specifier)) continue;
    const method = ACQUIRE_METHODS.find(
      (candidate) => candidate === importedPath.at(-1),
    );
    if (method !== undefined) return method;
  }
  return null;
};

const resourceNamespace = (
  binding: JavaScriptSemanticBindingState | undefined,
): boolean =>
  binding?.directOrigins.some(
    ({ specifier, importedPath }) =>
      resourceModule(specifier) && semanticBuiltinNamespacePath(importedPath),
  ) ?? false;

const resourceModule = (specifier: string): boolean =>
  [
    "fs",
    "fs/promises",
    "net",
    "node:fs",
    "node:fs/promises",
    "node:net",
    "node:tls",
    "tls",
  ].includes(specifier);

const resourceCandidateId = (candidate: ResourceCandidate): string =>
  `resource:acquire:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;
