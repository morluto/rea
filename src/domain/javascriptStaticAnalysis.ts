import { parse } from "@babel/parser";
import * as t from "@babel/types";

import {
  collectJavaScriptExports,
  fingerprintJavaScriptAst,
} from "./javascriptAstFingerprint.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentValue,
  calleeName,
  chunkRuntime,
  compareCodePoints,
  detectVendors,
  endpointArgument,
  failedJavaScriptStaticAnalysis,
  factoryRequireName,
  moduleFactory,
  modulePropertyName,
  prefixedArgument,
  propertyName,
  range,
  rangeForOffsets,
  registrationKey,
  sanitizeCandidate,
  sha256Text,
  sortedUnique,
  sourceSlice,
  staticArrayValues,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  type JavaScriptEndpointInput as EndpointInput,
  type JavaScriptFindingContext as FindingContext,
  type JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";
import {
  addBoundedFinding,
  addLocatedFinding,
  finalizeLocatedFindings,
  moduleAtOffset,
} from "./javascriptStaticAnalysisFindings.js";
import { inspectElectronStaticNode } from "./electronStaticAnalysis.js";
import type {
  JavaScriptBundlerModule,
  JavaScriptStaticAnalysis,
  JavaScriptStaticAnalysisLimits,
} from "./javascriptStaticAnalysisTypes.js";

/** Parse one bounded JavaScript artifact and recover static structure only. */
export const analyzeJavaScriptStaticSource = (
  source: string,
  limits: JavaScriptStaticAnalysisLimits,
): JavaScriptStaticAnalysis => {
  let file: ReturnType<typeof parse>;
  try {
    file = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return failedJavaScriptStaticAnalysis();
  }
  const accumulator = createJavaScriptAnalysisAccumulator();
  traverseStaticSource(source, file, accumulator, limits);
  addSourceMapDirectives(source, accumulator, limits.maxFindings);
  return finalizeStaticAnalysis(source, file, accumulator, limits);
};

const traverseStaticSource = (
  source: string,
  file: ReturnType<typeof parse>,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): void => {
  if (limits.now() > limits.deadline) accumulator.truncated = true;
  if (!accumulator.truncated)
    t.traverseFast(file, (node) => {
      accumulator.visitedNodes += 1;
      if (
        accumulator.visitedNodes > limits.maxAstNodes ||
        (accumulator.visitedNodes % 1_024 === 0 &&
          limits.now() > limits.deadline)
      ) {
        accumulator.truncated = true;
        return t.traverseFast.stop;
      }
      inspectNode(source, node, accumulator, limits);
      return undefined;
    });
};

const finalizeStaticAnalysis = (
  source: string,
  file: ReturnType<typeof parse>,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): JavaScriptStaticAnalysis => {
  const parserErrors = file.errors.length;
  const limitations = [
    ...(parserErrors === 0
      ? []
      : [
          "The parser recovered from syntax errors; affected facts are partial.",
        ]),
    ...(accumulator.truncated
      ? ["AST analysis stopped at the configured node or time bound."]
      : []),
    ...(accumulator.droppedFindings === 0
      ? []
      : ["Static findings were truncated at the configured finding bound."]),
    ...(accumulator.structuralTruncation
      ? ["Bundler metadata reached a per-record structural bound."]
      : []),
    ...(accumulator.unknownFindings === 0
      ? []
      : [
          "One or more static keys, expressions, or Electron boundary values were dynamic and remain unknown.",
        ]),
    "JavaScript syntax was parsed as data and was never evaluated.",
  ];
  return {
    parse_status:
      accumulator.truncated || accumulator.droppedFindings > 0
        ? "truncated"
        : parserErrors > 0 || accumulator.unknownFindings > 0
          ? "partial"
          : "complete",
    parse_error_count: parserErrors,
    visited_ast_nodes: Math.min(accumulator.visitedNodes, limits.maxAstNodes),
    dropped_findings: accumulator.droppedFindings,
    references: finalizeLocatedFindings(
      accumulator.references,
      accumulator.modules,
    ),
    endpoints: finalizeLocatedFindings(
      accumulator.endpoints,
      accumulator.modules,
    ),
    storage: finalizeLocatedFindings(accumulator.storage, accumulator.modules),
    bundler_registrations: sortedUnique(
      accumulator.registrations,
      registrationKey,
    ),
    role_paths: finalizeLocatedFindings(accumulator.roles, accumulator.modules),
    source_map_urls: accumulator.sourceMaps,
    vendors: detectVendors(source),
    electron: {
      browser_windows: finalizeLocatedFindings(
        accumulator.browserWindows,
        accumulator.modules,
      ),
      context_bridge_apis: finalizeLocatedFindings(
        accumulator.contextBridgeApis,
        accumulator.modules,
      ),
      ipc: finalizeLocatedFindings(accumulator.ipc, accumulator.modules),
      sender_validations: finalizeLocatedFindings(
        accumulator.senderValidations,
        accumulator.modules,
      ),
      utility_processes: finalizeLocatedFindings(
        accumulator.utilityProcesses,
        accumulator.modules,
      ),
      native_addon_bindings: finalizeLocatedFindings(
        accumulator.nativeAddonBindings,
        accumulator.modules,
      ),
    },
    limitations,
  };
};

const inspectNode = (
  source: string,
  node: t.Node,
  accumulator: AnalysisAccumulator,
  limits: JavaScriptStaticAnalysisLimits,
): void => {
  const findings: FindingContext = {
    source,
    accumulator,
    maximum: limits.maxFindings,
  };
  inspectElectronStaticNode(node, findings);
  if (t.isCallExpression(node)) {
    inspectBundlerRegistration(source, node, accumulator, limits);
    inspectCall(node, findings);
  } else if (t.isNewExpression(node)) inspectCall(node, findings);
  if (
    (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) &&
    node.source !== undefined
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (t.isExportNamedDeclaration(node) && node.source != null)
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (t.isImportExpression(node))
    addReference(findings, {
      node,
      kind: "dynamic-import",
      specifier: stringValue(node.source),
    });
  if (t.isObjectProperty(node)) {
    inspectRouteProperty(node, findings);
    inspectRoleProperty(node, findings);
  }
};

const inspectCall = (
  node: t.CallExpression | t.NewExpression,
  context: FindingContext,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const module = moduleAtOffset(node.start, accumulator.modules);
  const moduleRequireName = module?.requireName ?? null;
  const requireCall = requireCallSpecifier(node, name, moduleRequireName);
  if (requireCall !== null)
    addReference(context, {
      node,
      kind: "require",
      specifier: requireCall.specifier,
    });
  const chunkLoad = chunkLoadSpecifier(node, name, moduleRequireName);
  if (chunkLoad !== null)
    addReference(context, {
      node,
      kind: "dynamic-import",
      specifier: chunkLoad.specifier,
    });
  if (name === "Worker" || name.endsWith(".Worker"))
    addReference(context, { node, kind: "worker", specifier: first });
  if (name.endsWith("serviceWorker.register"))
    addReference(context, { node, kind: "service-worker", specifier: first });
  inspectEndpointCall(node, name, first, context);
  inspectStorageCall(node, name, first, context);
  if (name.endsWith("loadFile") && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "filesystem-expression",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
  if (name.endsWith("loadURL") && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "module-specifier",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
};

const requireCallSpecifier = (
  node: t.CallExpression | t.NewExpression,
  name: string,
  moduleRequireName: string | null,
): { readonly specifier: string | undefined } | null => {
  if (name === "require" || name.endsWith(".require"))
    return { specifier: argumentValue(node.arguments[0]) };
  if (name === "__webpack_require__" || name === moduleRequireName)
    return { specifier: argumentValue(node.arguments[0]) };
  if (
    name === "__webpack_require__.bind" ||
    (moduleRequireName !== null && name === `${moduleRequireName}.bind`)
  )
    return { specifier: argumentValue(node.arguments[1]) };
  return null;
};

const chunkLoadSpecifier = (
  node: t.CallExpression | t.NewExpression,
  name: string,
  moduleRequireName: string | null,
): { readonly specifier: string | undefined } | null => {
  if (
    name !== "__webpack_require__.e" &&
    (moduleRequireName === null || name !== `${moduleRequireName}.e`)
  )
    return null;
  return { specifier: prefixedArgument("chunk:", node.arguments[0]) };
};

const inspectBundlerRegistration = (
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

const inspectEndpointCall = (
  node: t.CallExpression | t.NewExpression,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const route = STATIC_ROUTE_CALL_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`.${candidate}`),
  );
  if (route && first !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value: first,
      mechanism: `call:${name}`,
    });
  const endpoint = endpointArgument(name, node.arguments);
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint,
      mechanism: `call:${name}`,
    });
};

const inspectRouteProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  const key = propertyName(node.key);
  if ((key === "path" || key === "route") && t.isStringLiteral(node.value))
    addEndpoint(context, {
      node,
      kind: "route",
      value: node.value.value,
      mechanism: `property:${key}`,
    });
};

const inspectRoleProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  if (propertyName(node.key) !== "preload") return;
  const path = staticPath(node.value);
  if (path === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.roles,
    key: `role\0preload\0${path}`,
    node,
    value: {
      role: "preload",
      path,
      resolution_context: staticPathResolutionContext(node.value),
      mechanism: "property:preload",
      module_key: null,
      location: range(node),
    },
  });
};

const inspectStorageCall = (
  node: t.CallExpression | t.NewExpression,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const storage = storageKind(name);
  if (storage === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.storage,
    key: `storage\0${storage}\0${first ?? ""}`,
    node,
    value: {
      kind: storage,
      name: first ?? null,
      mechanism: `call:${name}`,
      module_key: null,
      location: range(node),
    },
  });
};

const addReference = (context: FindingContext, input: ReferenceInput): void => {
  const boundedSpecifier = input.specifier?.slice(0, 4_096) ?? null;
  const expression =
    boundedSpecifier === null
      ? sourceSlice(context.source, input.node).slice(0, 4_096)
      : null;
  addLocatedFinding(context, {
    collection: context.accumulator.references,
    key: `reference\0${input.kind}\0${boundedSpecifier ?? expression}`,
    node: input.node,
    value: {
      kind: input.kind,
      specifier: boundedSpecifier,
      expression,
      module_key: null,
      location: range(input.node),
    },
  });
};

const addEndpoint = (context: FindingContext, input: EndpointInput): void =>
  addLocatedFinding(context, {
    collection: context.accumulator.endpoints,
    key: `endpoint\0${input.kind}\0${input.value}`,
    node: input.node,
    value: {
      kind: input.kind,
      value: sanitizeCandidate(input.value),
      mechanism: input.mechanism,
      module_key: null,
      location: range(input.node),
    },
  });

const addSourceMapDirectives = (
  source: string,
  accumulator: AnalysisAccumulator,
  maximum: number,
): void => {
  for (const match of source.matchAll(
    /\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s]+)/gu,
  )) {
    const declared = match[1]?.slice(0, 4_096);
    if (declared === undefined) continue;
    const start = match.index;
    const location = rangeForOffsets(source, start, start + match[0].length);
    addBoundedFinding(accumulator, `source-map\0${declared}`, maximum, () =>
      accumulator.sourceMaps.push({ declared_url: declared, location }),
    );
  }
};
