import { resolveElectronOptionObject } from "./electronStaticOptionObjects.js";
import * as t from "@babel/types";

import { compositeKey } from "../unicodeCodePointOrder.js";
import type {
  ElectronDynamicCodeFinding,
  ElectronDynamicCodeSource,
} from "./electronStaticAnalysisTypes.js";
import {
  boundedExpression,
  electronStaticValue,
} from "./electronStaticAnalysisValues.js";
import { builtinDataEffectCallablePath } from "./javascriptSemanticDataEffectHelpers.js";
import {
  semanticStaticPropertyKey,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  range,
  staticFileExpressionPath,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";

interface DynamicCodeInput {
  readonly context: JavaScriptFindingContext;
  readonly index: JavaScriptBindingIndex;
  readonly node: t.NewExpression | t.CallExpression;
  readonly api: ElectronDynamicCodeFinding["api"];
  readonly cachedDataArgument: "named" | "positional";
}

/**
 * Record `vm.Script`/`vm.compileFunction` sites during the shared traversal.
 * Option objects may be rebound, so the `cachedData` lookup is deferred to the
 * same post-traversal step that settles the other Electron findings.
 */
export const deferElectronDynamicCode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  // Identity waits for the settled index; this admits only the two syntax shapes
  // whose callee could name a `vm` member.
  const candidate =
    (t.isNewExpression(node) && syntacticMember(node.callee) === "Script") ||
    (t.isCallExpression(node) &&
      syntacticMember(node.callee) === "compileFunction");
  if (candidate) context.accumulator.pendingDynamicCode.push(node);
};

const syntacticMember = (callee: t.Node): string | null => {
  const node = unwrapJavaScriptExpression(callee).node;
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
    ? semanticStaticPropertyKey(node.property, node.computed)
    : null;
};

/** Resolve the deferred `node:vm` compilations against the settled index. */
export function* finishElectronDynamicCodeSteps(
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): Generator<void, void> {
  const pending = context.accumulator.pendingDynamicCode;
  if (pending.length === 0) return;
  yield* index.indexMemberMutationFactsSteps();
  for (const node of pending) {
    const api = t.isNewExpression(node)
      ? vmMemberAt(node.callee, index) === "Script"
        ? "vm.Script"
        : undefined
      : vmMemberAt(node.callee, index) === "compileFunction"
        ? "vm.compileFunction"
        : undefined;
    if (api === undefined) continue;
    const input: DynamicCodeInput = {
      context,
      index,
      node,
      api,
      cachedDataArgument: api === "vm.Script" ? "named" : "positional",
    };
    yield* addCompilation(input);
  }
  pending.length = 0;
}

/** Resolve the complete callable through the shared built-in identity owner. */
const vmMemberAt = (
  callee: t.Node,
  index: JavaScriptBindingIndex,
): string | undefined => {
  const path = builtinDataEffectCallablePath(callee, index.bindings, ["vm"]);
  return path?.length === 1 ? path[0] : undefined;
};

function* addCompilation(input: DynamicCodeInput): Generator<void, void> {
  const { context, node, api, cachedDataArgument } = input;
  const optionsPosition = cachedDataArgument === "named" ? 1 : 2;
  const spreadBeforeOptions = node.arguments
    .slice(0, optionsPosition + 1)
    .some((argument) => t.isSpreadElement(argument));
  const options = argumentNode(node.arguments[optionsPosition]);
  const lookup = spreadBeforeOptions
    ? ({ status: "dynamic" } as const)
    : options === undefined
      ? ({ status: "missing" } as const)
      : (() => {
          const resolved = resolveElectronOptionObject(
            options,
            options,
            input.index,
            ["cachedData"],
          );
          return resolved === undefined
            ? { status: "dynamic" as const }
            : staticObjectProperty(resolved, "cachedData");
        })();
  const cachedData: ElectronDynamicCodeSource =
    lookup.status === "explicit"
      ? sourceOf(input, lookup.value)
      : {
          source_path: null,
          source_resolution_context: null,
          source_expression:
            lookup.status === "dynamic"
              ? "cachedData: [dynamic-options]"
              : "[absent]",
        };
  addLocatedFinding(context, {
    collection: context.accumulator.dynamicCode,
    key: compositeKey([
      "electron-dynamic-code",
      api,
      cachedData.source_path,
      cachedData.source_expression,
    ]),
    node,
    value: {
      api,
      cached_data_status:
        lookup.status === "explicit"
          ? "declared"
          : lookup.status === "missing"
            ? "absent"
            : "unknown",
      cached_data: cachedData,
      source_text: electronStaticValue(
        context.source,
        argumentNode(node.arguments[0]),
      ),
      module_key: null,
      location: range(node),
    },
  });
  yield;
}

const sourceOf = (
  input: DynamicCodeInput,
  node: t.Node,
): ElectronDynamicCodeSource => {
  // `cachedData = fs.readFileSync(<path>)` names the cache through the read's
  // own argument; the call itself is not a path expression.
  const path = cachePathExpression(
    input.index,
    stableExpression(input.index, node) ?? node,
  );
  const fact =
    path === undefined
      ? undefined
      : staticFileExpressionPath(path, input.context.pathIntrinsics);
  return fact === undefined
    ? {
        source_path: null,
        source_resolution_context: null,
        source_expression: boundedExpression(input.context.source, node),
      }
    : {
        source_path: fact.path,
        source_path_base: fact.base,
        source_resolution_context: "filesystem-expression",
        source_expression: null,
      };
};

/** The path argument of a proven `fs` read that produced the cache value. */
const cachePathExpression = (
  index: JavaScriptBindingIndex,
  node: t.Node,
): t.Node | undefined => {
  const value = unwrapJavaScriptExpression(node).node;
  const awaited = t.isAwaitExpression(value);
  const expression = awaited
    ? unwrapJavaScriptExpression(value.argument).node
    : value;
  if (!t.isCallExpression(expression)) return undefined;
  const read = builtinDataEffectCallablePath(
    expression.callee,
    index.bindings,
    awaited ? ["fs/promises"] : ["fs"],
  );
  const target =
    read?.length === 1 && read[0] === (awaited ? "readFile" : "readFileSync")
      ? argumentNode(expression.arguments[0])
      : undefined;
  return target === undefined
    ? undefined
    : unwrapJavaScriptExpression(target).node;
};

/**
 * Follow one unrebound `const` to its sole initializer so a cache read into a
 * local name still names the artifact, exactly as the option-object owner does.
 */
const stableExpression = (
  index: JavaScriptBindingIndex,
  node: t.Node,
): t.Node | undefined => {
  const expression = unwrapJavaScriptExpression(node).node;
  if (!t.isIdentifier(expression)) return undefined;
  const binding = index.bindingForReferenceAt(expression);
  if (binding?.mutable !== false) return undefined;
  const initializer = semanticStableInitializer(binding, index.bindings);
  return initializer === undefined
    ? undefined
    : unwrapJavaScriptExpression(initializer.node).node;
};
