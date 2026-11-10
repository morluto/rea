import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  hasJavaScriptViteInheritedProperty,
  isJavaScriptViteDefaultUndefined,
  readJavaScriptViteHelper,
  readJavaScriptViteTableSlotsSteps,
  tableMayAffectIndexesSteps,
  javaScriptViteTableHasOwnSlot,
  type JavaScriptViteHelperCandidate,
  type JavaScriptViteCacheTable,
} from "./javascriptViteHelper.js";
import { invalidateJavaScriptViteCachesSteps } from "./javascriptViteCacheOwnership.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAstSteps } from "./javascriptSemanticTraversal.js";
import { semanticBindingMayHaveOpaqueEffect } from "./javascriptSemanticOpaqueEffects.js";
import type { ParsedJavaScriptSource } from "./javascriptSourceParser.js";

type ViteDependencyTable = readonly (string | undefined)[];
type ViteDependencyCall = t.CallExpression | t.OptionalCallExpression;

/** resolve emitted Vite helpers by lexical identity without executing them. */
export function* classifyParsedJavaScriptViteDependencySpecifiersSteps(
  file: ParsedJavaScriptSource,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ReadonlyMap<ViteDependencyCall, ViteDependencyTable>> {
  const candidates: JavaScriptViteHelperCandidate[] = [];
  yield* traverseJavaScriptValueAstSteps(
    file.program,
    state.erasedSyntaxNodes,
    {
      enter: (node) => {
        const candidate = readJavaScriptViteHelper(node, state);
        if (candidate !== undefined) candidates.push(candidate);
      },
    },
  );
  const calls = new Map<ViteDependencyCall, ViteDependencyTable>();
  if (candidates.length === 0) return calls;
  const { tables, cacheHelpers } = yield* viteBindingTablesSteps(
    candidates,
    state,
  );
  const initializations = new Set<t.Node | undefined>();
  const admittedNodes = new WeakSet<t.Node>();
  for (const [
    index,
    { table, projection, cacheReads },
  ] of candidates.entries()) {
    if (index % 1024 === 0) yield;
    initializations.add(state.parentsByNode.get(table));
    admittedNodes.add(projection);
    // These exact guard reads address the admitted helper's own cache. Other
    // default expressions, including table contents, retain ordinary effects.
    for (const read of cacheReads) admittedNodes.add(read);
  }
  yield* invalidateJavaScriptViteCachesSteps(
    file.program,
    tables,
    cacheHelpers,
    initializations,
    admittedNodes,
    state,
  );
  const classifiedCalls: {
    readonly node: ViteDependencyCall;
    readonly table: JavaScriptViteCacheTable | null | undefined;
  }[] = [];
  yield* traverseJavaScriptValueAstSteps(
    file.program,
    state.erasedSyntaxNodes,
    {
      enter: (node) => {
        if (
          (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
          !t.isIdentifier(node.callee, { name: "__vite__mapDeps" })
        )
          return;
        const binding = resolveSemanticBindingState(
          state,
          node.callee,
          node.callee.name,
        );
        if (binding !== undefined && tables.has(binding.bindingId))
          classifiedCalls.push({ node, table: tables.get(binding.bindingId) });
      },
    },
  );
  for (const [index, { node, table }] of classifiedCalls.entries()) {
    if (index % 1024 === 0) yield;
    calls.set(
      node,
      yield* selectedDependencySpecifiersSteps(node, table, state),
    );
  }
  return calls;
}

function* viteBindingTablesSteps(
  candidates: readonly JavaScriptViteHelperCandidate[],
  state: JavaScriptSemanticAnalysisState,
): Generator<
  void,
  {
    tables: Map<string, JavaScriptViteCacheTable | null>;
    cacheHelpers: Map<string, JavaScriptViteHelperCandidate>;
  }
> {
  const tables = new Map<string, JavaScriptViteCacheTable | null>();
  const cacheHelpers = new Map<string, JavaScriptViteHelperCandidate>();
  for (const [index, candidate] of candidates.entries()) {
    if (index % 1024 === 0) yield;
    const { name, helper, table, uncertain } = candidate;
    const binding = resolveSemanticBindingState(state, name, name.name);
    if (binding === undefined) continue;
    cacheHelpers.set(binding.bindingId, candidate);
    const initializer = semanticStableInitializer(binding, state);
    const unchanged =
      !uncertain &&
      !(yield* tableMayAffectIndexesSteps(table, helper, state)) &&
      !semanticBindingMayHaveOpaqueEffect(
        binding,
        state,
        undefined,
        "reference",
      ) &&
      initializer !== undefined &&
      unwrapJavaScriptExpression(initializer.node).node === helper &&
      initializer.projection.length === 0;
    tables.set(
      binding.bindingId,
      unchanged ? yield* readJavaScriptViteTableSlotsSteps(table) : null,
    );
  }
  return { tables, cacheHelpers };
}

/** An inert unary index cannot execute code; unsupported slots stay unknown. */
const inertIndexSlot = (
  value: t.Node,
): { readonly numeric: number } | undefined => {
  if (
    !t.isUnaryExpression(value) ||
    !(value.operator === "+" || value.operator === "-") ||
    !t.isNumericLiteral(value.argument)
  )
    return undefined;
  return {
    numeric:
      value.operator === "+" ? value.argument.value : -value.argument.value,
  };
};

function* selectedDependencySpecifiersSteps(
  node: ViteDependencyCall,
  table: JavaScriptViteCacheTable | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ViteDependencyTable> {
  if (table == null || !(yield* usesDefaultTableSteps(node, state)))
    return [undefined];
  const argument = node.arguments[0];
  if (argument === undefined) return [undefined];
  const indexes = unwrapJavaScriptExpression(argument).node;
  if (!t.isArrayExpression(indexes)) return [undefined];
  // all arguments are evaluated before map starts, including a later slot.
  // validate the whole literal before a mapped read can stop exact decoding.
  for (const [index, element] of indexes.elements.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (element === null) continue;
    const value = unwrapJavaScriptExpression(element).node;
    if (
      !t.isIdentifier(value) &&
      !readExactJavaScriptLiteral(value).found &&
      inertIndexSlot(value) === undefined
    )
      return [undefined];
  }
  const selected: (string | undefined)[] = [];
  for (const [index, element] of indexes.elements.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (element === null) {
      // native map visits inherited indexes even when the input has an elision.
      if (hasJavaScriptViteInheritedProperty(index, state)) {
        selected.push(undefined);
        return selected;
      }
      continue;
    }
    const value = unwrapJavaScriptExpression(element).node;
    const inert = inertIndexSlot(value);
    const literal = readExactJavaScriptLiteral(value);
    const numeric = t.isNumericLiteral(value) ? value.value : inert?.numeric;
    selected.push(
      numeric !== undefined && Number.isSafeInteger(numeric) && numeric >= 0
        ? (table[numeric] ?? undefined)
        : undefined,
    );
    const key = literal.found
      ? String(literal.value)
      : inert === undefined
        ? undefined
        : String(inert.numeric);
    const own = javaScriptViteTableHasOwnSlot(key ?? null, table);
    // key coercion and inherited getters can change every subsequent read.
    // unknown owned values remain inert, preserving unrelated exact slots.
    if (
      key === undefined ||
      (!own && hasJavaScriptViteInheritedProperty(key, state))
    )
      return selected;
  }
  return selected;
}

function* usesDefaultTableSteps(
  node: ViteDependencyCall,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  for (let index = 0; index < Math.min(node.arguments.length, 3); index++)
    if (t.isSpreadElement(node.arguments[index])) return false;
  for (const index of [1, 2]) {
    const argument = node.arguments[index];
    if (
      argument !== undefined &&
      !isJavaScriptViteDefaultUndefined(argument, state)
    )
      return false;
  }
  for (let index = 3; index < node.arguments.length; index++) {
    if (index % 1024 === 0) yield;
    const argument = node.arguments[index];
    if (
      argument === undefined ||
      (!readExactJavaScriptLiteral(argument).found &&
        !isJavaScriptViteDefaultUndefined(argument, state))
    )
      return false;
  }
  return true;
}
