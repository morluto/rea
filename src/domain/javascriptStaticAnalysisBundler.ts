import * as t from "@babel/types";

import {
  collectJavaScriptExports,
  fingerprintJavaScriptAst,
} from "./javascriptAstFingerprint.js";
import { addBoundedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentValue,
  calleeName,
  chunkRuntime,
  compareCodePoints,
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
  JavaScriptStaticAnalysisLimits,
} from "./javascriptStaticAnalysisTypes.js";

/** Inspect a bundler registration call and recover its module table. */
export const inspectBundlerRegistration = (
  source: string,
  call: t.CallExpression,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): void => {
  const runtime = chunkRuntime(call);
  const entry = call.arguments[0];
  if (runtime === undefined || !t.isArrayExpression(entry)) return;
  const chunkIds = entry.elements[0];
  const table = entry.elements[1];
  const runtimeValue = runtimeMetadata(entry.elements[2], limits.maxFindings);
  if (!t.isArrayExpression(chunkIds) || !t.isObjectExpression(table)) return;
  const recovered = recoverBundlerModules(source, table, accumulator, limits);
  const chunkKeys = staticArrayValues(
    chunkIds,
    Math.min(256, limits.maxFindings),
  );
  if (chunkKeys.omitted > 0) {
    accumulator.droppedFindings += chunkKeys.omitted;
    accumulator.structuralTruncation = true;
  }
  accumulator.unknownFindings += chunkKeys.unknown;
  if (
    runtimeValue.omittedEntryModuleKeys > 0 ||
    runtimeValue.omittedAsyncChunkKeys > 0 ||
    recovered.omittedAsyncChunkKeys > 0
  ) {
    accumulator.droppedFindings +=
      runtimeValue.omittedEntryModuleKeys +
      runtimeValue.omittedAsyncChunkKeys +
      recovered.omittedAsyncChunkKeys;
    accumulator.structuralTruncation = true;
  }
  accumulator.unknownFindings +=
    runtimeValue.unknownEntryModuleKeys +
    runtimeValue.unknownAsyncChunkKeys +
    recovered.unknownAsyncChunkKeys;
  const asyncChunkKeys = boundedUniqueValues(
    [...runtimeValue.asyncChunkKeys, ...recovered.asyncChunkKeys],
    Math.min(256, limits.maxFindings),
  );
  if (asyncChunkKeys.omitted > 0) {
    accumulator.droppedFindings += asyncChunkKeys.omitted;
    accumulator.structuralTruncation = true;
  }
  const registration = {
    bundler: runtime.toLowerCase().includes("rspack")
      ? ("rspack" as const)
      : ("webpack" as const),
    runtime,
    chunk_keys: chunkKeys.values,
    omitted_chunk_keys: chunkKeys.omitted,
    unknown_chunk_keys: chunkKeys.unknown,
    runtime_require_name: runtimeValue.requireName,
    runtime_module_cache_status: bundlerModuleCacheStatus(source),
    entry_module_keys: runtimeValue.entryModuleKeys,
    omitted_entry_module_keys: runtimeValue.omittedEntryModuleKeys,
    unknown_entry_module_keys: runtimeValue.unknownEntryModuleKeys,
    async_chunk_keys: asyncChunkKeys.values,
    omitted_async_chunk_keys:
      runtimeValue.omittedAsyncChunkKeys +
      recovered.omittedAsyncChunkKeys +
      asyncChunkKeys.omitted,
    unknown_async_chunk_keys:
      runtimeValue.unknownAsyncChunkKeys + recovered.unknownAsyncChunkKeys,
    modules: recovered.modules.sort((left, right) =>
      compareCodePoints(left.module_key, right.module_key),
    ),
    location: range(call),
  };
  addBoundedFinding(
    accumulator,
    `registration\0${registrationKey(registration)}`,
    limits.maxFindings,
    () => accumulator.registrations.push(registration),
  );
};

interface RecoveredBundlerModules {
  readonly modules: JavaScriptBundlerModule[];
  readonly asyncChunkKeys: readonly string[];
  readonly omittedAsyncChunkKeys: number;
  readonly unknownAsyncChunkKeys: number;
}

const recoverBundlerModules = (
  source: string,
  table: t.ObjectExpression,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): RecoveredBundlerModules => {
  const modules: JavaScriptBundlerModule[] = [];
  const asyncChunkKeys: string[] = [];
  let omittedAsyncChunkKeys = 0;
  let unknownAsyncChunkKeys = 0;
  for (const property of table.properties) {
    const recovered = recoverBundlerModule(
      source,
      property,
      accumulator,
      limits,
    );
    if (recovered === null) continue;
    modules.push(recovered.module);
    asyncChunkKeys.push(...recovered.asyncChunkKeys);
    omittedAsyncChunkKeys += recovered.omittedAsyncChunkKeys;
    unknownAsyncChunkKeys += recovered.unknownAsyncChunkKeys;
  }
  return {
    modules,
    asyncChunkKeys,
    omittedAsyncChunkKeys,
    unknownAsyncChunkKeys,
  };
};

const recoverBundlerModule = (
  source: string,
  property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): {
  readonly module: JavaScriptBundlerModule;
  readonly asyncChunkKeys: readonly string[];
  readonly omittedAsyncChunkKeys: number;
  readonly unknownAsyncChunkKeys: number;
} | null => {
  const factory = moduleFactory(property);
  if (factory === undefined) return null;
  if (accumulator.moduleCount >= limits.maxModules) {
    accumulator.droppedFindings += 1;
    return null;
  }
  accumulator.moduleCount += 1;
  const key = modulePropertyName(property);
  if (key.startsWith("[computed@") || key.startsWith("[unknown@"))
    accumulator.unknownFindings += 1;
  const fingerprint = fingerprintJavaScriptAst(
    factory,
    Math.min(limits.maxAstNodes, 100_000),
  );
  const exportsValue = collectJavaScriptExports(factory, 256);
  const requireName = factoryRequireName(factory);
  const asyncChunks = collectBundlerAsyncChunkKeys(
    factory,
    requireName,
    limits.maxFindings,
  );
  if (fingerprint.truncated || exportsValue.truncated) {
    accumulator.droppedFindings += 1;
    accumulator.structuralTruncation = true;
  }
  if (typeof factory.start === "number" && typeof factory.end === "number")
    accumulator.modules.push({
      start: factory.start,
      end: factory.end,
      key,
      requireName,
    });
  return {
    module: {
      module_key: key,
      factory_require_name: requireName,
      source_sha256: sha256Text(sourceSlice(source, factory)),
      structural_fingerprint_sha256: fingerprint.truncated
        ? null
        : fingerprint.sha256,
      structural_fingerprint_algorithm: fingerprint.truncated
        ? null
        : ("babel-ast-v1" as const),
      structural_fingerprint_status: fingerprint.truncated
        ? ("truncated" as const)
        : ("complete" as const),
      exports: exportsValue.values,
      exports_truncated: exportsValue.truncated,
      location: range(factory),
    },
    asyncChunkKeys: asyncChunks.values,
    omittedAsyncChunkKeys: asyncChunks.omitted,
    unknownAsyncChunkKeys: asyncChunks.unknown,
  };
};

interface RuntimeMetadata {
  readonly requireName: string | null;
  readonly entryModuleKeys: readonly string[];
  readonly omittedEntryModuleKeys: number;
  readonly unknownEntryModuleKeys: number;
  readonly asyncChunkKeys: readonly string[];
  readonly omittedAsyncChunkKeys: number;
  readonly unknownAsyncChunkKeys: number;
}

interface BoundedValues {
  readonly values: readonly string[];
  readonly omitted: number;
  readonly unknown: number;
}

type BundlerFunction =
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod;

const runtimeMetadata = (
  node: t.Node | null | undefined,
  maximum: number,
): RuntimeMetadata => {
  if (!isBundlerFunction(node))
    return {
      requireName: null,
      entryModuleKeys: [],
      omittedEntryModuleKeys: 0,
      unknownEntryModuleKeys: node === null || node === undefined ? 0 : 1,
      asyncChunkKeys: [],
      omittedAsyncChunkKeys: 0,
      unknownAsyncChunkKeys: 0,
    };
  const parameter = node.params[0];
  const requireName = t.isIdentifier(parameter)
    ? parameter.name.slice(0, 4_096)
    : null;
  if (requireName === null)
    return {
      requireName,
      entryModuleKeys: [],
      omittedEntryModuleKeys: 0,
      unknownEntryModuleKeys: 1,
      asyncChunkKeys: [],
      omittedAsyncChunkKeys: 0,
      unknownAsyncChunkKeys: 0,
    };
  const entries = collectBundlerEntryModuleKeys(node, requireName, maximum);
  const asyncChunks = collectBundlerAsyncChunkKeys(node, requireName, maximum);
  return {
    requireName,
    entryModuleKeys: entries.values,
    omittedEntryModuleKeys: entries.omitted,
    unknownEntryModuleKeys: entries.unknown,
    asyncChunkKeys: asyncChunks.values,
    omittedAsyncChunkKeys: asyncChunks.omitted,
    unknownAsyncChunkKeys: asyncChunks.unknown,
  };
};

const collectBundlerEntryModuleKeys = (
  factory: BundlerFunction,
  requireName: string,
  maximum: number,
): BoundedValues =>
  collectBundlerCallArgumentValues(factory, requireName, maximum);

const collectBundlerAsyncChunkKeys = (
  factory: BundlerFunction,
  requireName: string | null,
  maximum: number,
): BoundedValues =>
  requireName === null
    ? { values: [], omitted: 0, unknown: 0 }
    : collectBundlerCallArgumentValues(factory, `${requireName}.e`, maximum);

const collectBundlerCallArgumentValues = (
  factory: BundlerFunction,
  callee: string,
  maximum: number,
): BoundedValues => {
  const values: string[] = [];
  let unknown = 0;
  t.traverseFast(factory, (node) => {
    if (!t.isCallExpression(node) && !t.isNewExpression(node)) return undefined;
    if (calleeName(node.callee) !== callee) return undefined;
    const value = argumentValue(node.arguments[0]);
    if (value === undefined) unknown += 1;
    else values.push(value);
    return undefined;
  });
  return boundedUniqueValues(values, Math.min(256, maximum), unknown);
};

const isBundlerFunction = (
  node: t.Node | null | undefined,
): node is BundlerFunction =>
  t.isFunctionExpression(node) ||
  t.isArrowFunctionExpression(node) ||
  t.isObjectMethod(node);

const boundedUniqueValues = (
  values: readonly string[],
  maximum: number,
  unknown = 0,
): BoundedValues => {
  const bounded = [
    ...new Set(values.map((value) => value.slice(0, 4_096))),
  ].sort(compareCodePoints);
  const retained = bounded.slice(0, Math.max(0, maximum));
  return {
    values: retained,
    omitted: Math.max(0, bounded.length - retained.length),
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
