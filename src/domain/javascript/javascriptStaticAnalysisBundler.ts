import * as t from "@babel/types";

import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import {
  collectJavaScriptExports,
  fingerprintJavaScriptAst,
} from "./javascriptAstFingerprint.js";
import { compareCodePoints } from "../canonicalOrdering.js";
import { addFindingOnce } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentValue,
  calleeName,
  chunkRuntime,
  factoryRequireName,
  moduleFactory,
  modulePropertyName,
  range,
  registrationKey,
  sha256Text,
  sourceSlice,
  staticArrayValues,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptAnalysisAccumulator as AnalysisAccumulator } from "./javascriptStaticAnalysisState.js";
import type {
  JavaScriptBundlerModule,
  JavaScriptBundlerRegistration,
} from "./javascriptStaticAnalysisTypes.js";

/** Inspect a bundler registration call and recover its module table. */
export const inspectBundlerRegistration = (
  source: string,
  call: t.CallExpression,
  accumulator: AnalysisAccumulator,
): void => {
  const runtime = chunkRuntime(call);
  const entry = call.arguments[0];
  if (runtime === undefined || !t.isArrayExpression(entry)) return;
  const chunkIds = entry.elements[0];
  const table = entry.elements[1];
  const runtimeValue = runtimeMetadata(entry.elements[2]);
  if (!t.isArrayExpression(chunkIds) || !t.isObjectExpression(table)) return;
  const recovered = recoverBundlerModules(source, table, accumulator);
  const chunkKeys = staticArrayValues(chunkIds);
  accumulator.unknownFindings += chunkKeys.unknown;
  accumulator.unknownFindings +=
    runtimeValue.unknownEntryModuleKeys +
    runtimeValue.unknownAsyncChunkKeys +
    recovered.unknownAsyncChunkKeys;
  const asyncChunkKeys = uniqueValues([
    ...runtimeValue.asyncChunkKeys,
    ...recovered.asyncChunkKeys,
  ]);
  const registration = {
    bundler: runtime.toLowerCase().includes("rspack")
      ? ("rspack" as const)
      : ("webpack" as const),
    runtime,
    chunk_keys: chunkKeys.values,
    unknown_chunk_keys: chunkKeys.unknown,
    runtime_require_name: runtimeValue.requireName,
    runtime_module_cache_status: bundlerModuleCacheStatus(source),
    entry_module_keys: runtimeValue.entryModuleKeys,
    unknown_entry_module_keys: runtimeValue.unknownEntryModuleKeys,
    async_chunk_keys: asyncChunkKeys.values,
    unknown_async_chunk_keys:
      runtimeValue.unknownAsyncChunkKeys + recovered.unknownAsyncChunkKeys,
    modules: recovered.modules.sort((left, right) =>
      compareCodePoints(left.module_key, right.module_key),
    ),
    location: range(call),
  };
  addFindingOnce(
    accumulator,
    `registration\0${registrationKey(registration)}`,
    () => accumulator.registrations.push(registration),
  );
};

/** Inspect esbuild helper wrappers and recover their literal module tables. */
export const inspectEsbuildWrapper = (
  source: string,
  call: t.CallExpression,
  accumulator: AnalysisAccumulator,
): void => {
  const name = calleeName(call.callee);
  const wrapperKind =
    name === "__commonJS" || name.endsWith(".__commonJS")
      ? "commonjs"
      : name === "__esm" || name.endsWith(".__esm")
        ? "esm"
        : null;
  const table = call.arguments[0];
  if (wrapperKind === null || !t.isObjectExpression(table)) return;
  const recovered = recoverBundlerModules(source, table, accumulator);
  if (recovered.modules.length === 0) return;
  accumulator.unknownFindings += recovered.unknownAsyncChunkKeys;
  const registration: JavaScriptBundlerRegistration = {
    bundler: "esbuild",
    runtime: `esbuild-${wrapperKind}`,
    chunk_keys: [`${wrapperKind}@${String(call.start ?? 0)}`],
    unknown_chunk_keys: 0,
    runtime_require_name: null,
    runtime_module_cache_status: "not-observed",
    entry_module_keys: [],
    unknown_entry_module_keys: 0,
    async_chunk_keys: recovered.asyncChunkKeys,
    unknown_async_chunk_keys: recovered.unknownAsyncChunkKeys,
    modules: recovered.modules.sort((left, right) =>
      compareCodePoints(left.module_key, right.module_key),
    ),
    location: range(call),
  };
  addFindingOnce(
    accumulator,
    `registration\0${registrationKey(registration)}`,
    () => accumulator.registrations.push(registration),
  );
};

interface RecoveredBundlerModules {
  readonly modules: JavaScriptBundlerModule[];
  readonly asyncChunkKeys: readonly string[];
  readonly unknownAsyncChunkKeys: number;
}

const recoverBundlerModules = (
  source: string,
  table: t.ObjectExpression,
  accumulator: AnalysisAccumulator,
): RecoveredBundlerModules => {
  const modules: JavaScriptBundlerModule[] = [];
  const asyncChunkKeys: string[] = [];
  let unknownAsyncChunkKeys = 0;
  for (const property of table.properties) {
    const recovered = recoverBundlerModule(source, property, accumulator);
    if (recovered === null) continue;
    modules.push(recovered.module);
    asyncChunkKeys.push(...recovered.asyncChunkKeys);
    unknownAsyncChunkKeys += recovered.unknownAsyncChunkKeys;
  }
  return {
    modules,
    asyncChunkKeys,
    unknownAsyncChunkKeys,
  };
};

const recoverBundlerModule = (
  source: string,
  property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
  accumulator: AnalysisAccumulator,
): {
  readonly module: JavaScriptBundlerModule;
  readonly asyncChunkKeys: readonly string[];
  readonly unknownAsyncChunkKeys: number;
} | null => {
  const factory = moduleFactory(property);
  if (factory === undefined) return null;
  const key = modulePropertyName(property);
  if (key.startsWith("[computed@") || key.startsWith("[unknown@"))
    accumulator.unknownFindings += 1;
  const fingerprint = fingerprintJavaScriptAst(factory);
  const exportsValue = collectJavaScriptExports(factory);
  const requireName = factoryRequireName(factory);
  const asyncChunks = collectBundlerAsyncChunkKeys(factory, requireName);
  if (typeof factory.start === "number" && typeof factory.end === "number") {
    const moduleRange = {
      start: factory.start,
      end: factory.end,
      key,
      requireName,
    };
    accumulator.moduleRangeIndex.add(moduleRange);
  }
  return {
    module: {
      module_key: key,
      factory_require_name: requireName,
      source_sha256: sha256Text(sourceSlice(source, factory)),
      structural_fingerprint_sha256: fingerprint,
      structural_fingerprint_algorithm: "babel-ast-v1",
      exports: exportsValue.values,
      location: range(factory),
    },
    asyncChunkKeys: asyncChunks.values,
    unknownAsyncChunkKeys: asyncChunks.unknown,
  };
};

interface RuntimeMetadata {
  readonly requireName: string | null;
  readonly entryModuleKeys: readonly string[];
  readonly unknownEntryModuleKeys: number;
  readonly asyncChunkKeys: readonly string[];
  readonly unknownAsyncChunkKeys: number;
}

interface StaticValues {
  readonly values: readonly string[];
  readonly unknown: number;
}

type BundlerFunction =
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod;

const runtimeMetadata = (node: t.Node | null | undefined): RuntimeMetadata => {
  if (!isBundlerFunction(node))
    return {
      requireName: null,
      entryModuleKeys: [],
      unknownEntryModuleKeys: node === null || node === undefined ? 0 : 1,
      asyncChunkKeys: [],
      unknownAsyncChunkKeys: 0,
    };
  const parameter = node.params[0];
  const requireName = t.isIdentifier(parameter) ? parameter.name : null;
  if (requireName === null)
    return {
      requireName,
      entryModuleKeys: [],
      unknownEntryModuleKeys: 1,
      asyncChunkKeys: [],
      unknownAsyncChunkKeys: 0,
    };
  const entries = collectBundlerEntryModuleKeys(node, requireName);
  const asyncChunks = collectBundlerAsyncChunkKeys(node, requireName);
  return {
    requireName,
    entryModuleKeys: entries.values,
    unknownEntryModuleKeys: entries.unknown,
    asyncChunkKeys: asyncChunks.values,
    unknownAsyncChunkKeys: asyncChunks.unknown,
  };
};

const collectBundlerEntryModuleKeys = (
  factory: BundlerFunction,
  requireName: string,
): StaticValues => collectBundlerCallArgumentValues(factory, requireName);

const collectBundlerAsyncChunkKeys = (
  factory: BundlerFunction,
  requireName: string | null,
): StaticValues =>
  requireName === null
    ? { values: [], unknown: 0 }
    : collectBundlerCallArgumentValues(factory, `${requireName}.e`);

const collectBundlerCallArgumentValues = (
  factory: BundlerFunction,
  callee: string,
): StaticValues => {
  const values: string[] = [];
  let unknown = 0;
  traverseJavaScriptAst(factory, {
    enter: (node) => {
      if (!t.isCallExpression(node) && !t.isNewExpression(node))
        return undefined;
      if (calleeName(node.callee) !== callee) return undefined;
      const value = argumentValue(node.arguments[0]);
      if (value === undefined) unknown += 1;
      else values.push(value);
      return undefined;
    },
  });
  return uniqueValues(values, unknown);
};

const isBundlerFunction = (
  node: t.Node | null | undefined,
): node is BundlerFunction =>
  t.isFunctionExpression(node) ||
  t.isArrowFunctionExpression(node) ||
  t.isObjectMethod(node);

const uniqueValues = (values: readonly string[], unknown = 0): StaticValues => {
  const unique = [...new Set(values)].sort(compareCodePoints);
  return {
    values: unique,
    unknown,
  };
};

const bundlerModuleCacheStatus = (
  source: string,
): "observed" | "not-observed" =>
  /\b(?:__webpack_module_cache__|__rspack_module_cache__|installedModules)\b/u.test(
    source,
  )
    ? "observed"
    : "not-observed";
