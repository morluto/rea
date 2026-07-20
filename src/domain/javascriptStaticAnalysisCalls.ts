import * as t from "@babel/types";

import {
  addBoundedFinding,
  addLocatedFinding,
  moduleAtOffset,
} from "./javascriptStaticAnalysisFindings.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentValue,
  calleeName,
  endpointArgument as endpointArgumentHelper,
  prefixedArgument,
  propertyName,
  range,
  rangeForOffsets,
  sanitizeCandidate,
  sourceSlice,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import type {
  JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  JavaScriptEndpointInput as EndpointInput,
  JavaScriptFindingContext as FindingContext,
  JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";

/** Inspect one call or new expression for references, endpoints, storage, and roles. */
export const inspectCall = (
  source: string,
  node: t.CallExpression | t.NewExpression,
  context: FindingContext,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const module = moduleAtOffset(node.start, context.accumulator.modules);
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
  for (const specifier of vitePreloadDependencySpecifiers(source, node, name))
    addReference(context, { node, kind: "dynamic-import", specifier });
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

const vitePreloadDependencySpecifiers = (
  source: string,
  node: t.CallExpression | t.NewExpression,
  name: string,
): readonly string[] => {
  if (name !== "__vite__mapDeps" || !t.isArrayExpression(node.arguments[0]))
    return [];
  const indexes = node.arguments[0].elements.flatMap((element) =>
    t.isNumericLiteral(element) ? [element.value] : [],
  );
  if (indexes.length !== node.arguments[0].elements.length) return [];
  const table = vitePreloadDependencyTable(source);
  return indexes.flatMap((index) => table[index] ?? []);
};

const vitePreloadDependencyTable = (source: string): readonly string[] => {
  const match =
    /\.\s*f\s*\|\|\s*\(\s*[^)]*?\.f\s*=\s*\[([\s\S]*?)\]\s*\)/u.exec(source);
  const body = match?.[1];
  if (body === undefined) return [];
  return [
    ...body.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/gu),
  ]
    .map((literal) => (literal[1] ?? literal[2] ?? "").slice(0, 4_096))
    .slice(0, 256);
};

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
  const endpoint = endpointArgumentHelper(name, node.arguments);
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint,
      mechanism: `call:${name}`,
    });
};

export const inspectRouteProperty = (
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

export const inspectRoleProperty = (
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

export const addReference = (
  context: FindingContext,
  input: ReferenceInput,
): void => {
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

export const addSourceMapDirectives = (
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
