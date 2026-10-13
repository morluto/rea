import * as t from "@babel/types";

import { htmlUrlText, stripQueryAndFragment } from "../artifactPathSyntax.js";
import { sanitizeEndpointCandidate } from "../browserObservation.js";
import {
  addFindingOnce,
  addLocatedFinding,
} from "./javascriptStaticAnalysisFindings.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentNode,
  argumentValue,
  calleeName,
  endpointArgument as endpointArgumentHelper,
  prefixedArgument,
  range,
  rangeForOffsets,
  sourceSlice,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type {
  JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  JavaScriptEndpointInput as EndpointInput,
  JavaScriptFindingContext as FindingContext,
  JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";

type JavaScriptCallLike =
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression;

/** Inspect one call or new expression for references, endpoints, storage, and roles. */
export const inspectCall = (
  source: string,
  node: JavaScriptCallLike,
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const module = context.accumulator.moduleRangeIndex.find(node.start);
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
  const worker = t.isNewExpression(node) ? node : undefined;
  const workerConstructor =
    worker === undefined
      ? undefined
      : workerConstructorKind(worker.callee, bindings);
  if (
    workerConstructor !== undefined ||
    name === "Worker" ||
    name.endsWith(".Worker")
  )
    addReference(context, {
      node,
      kind: "worker",
      // Node string paths use the process cwd or filesystem root, neither of
      // which is established by the analyzed source's artifact location.
      specifier:
        (workerConstructor === "node" ? undefined : first) ??
        (workerConstructor === undefined || worker === undefined
          ? undefined
          : workerUrlSpecifier(worker, bindings)),
    });
  if (name.endsWith("serviceWorker.register"))
    addReference(context, { node, kind: "service-worker", specifier: first });
  inspectEndpointCall(node, name, first, context);
  inspectStorageCall(node, name, first, context);
  if (first === "audio" || first === "video")
    noteMediaElementPreloads(node, accumulator);
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

const workerUrlSpecifier = (
  worker: t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): string | undefined => {
  const argumentExpression = argumentNode(worker.arguments[0]);
  if (argumentExpression === undefined) return undefined;
  const node = unwrapJavaScriptExpression(argumentExpression).node;
  if (!t.isNewExpression(node)) return undefined;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    !isUnmodifiedGlobalReference(callee, bindings, "URL") ||
    !isUnmodifiedImportMetaUrl(argumentNode(node.arguments[1]), bindings)
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  if (specifier === undefined) return undefined;
  const pathname = stripQueryAndFragment(specifier);
  // The module URL's scheme and filesystem/origin root are unavailable. Only
  // relative pathnames can establish a location within the artifact; retain
  // rooted paths and paths requiring URL text normalization as expressions.
  // Malformed percent escapes survive HTTP URL parsing but cannot be converted
  // from a file URL to a Node Worker path. Without the base scheme, keep that
  // ambiguity unknown; query and fragment bytes do not affect pathname lookup.
  return pathname.length > 0 &&
    !pathname.startsWith("/") &&
    !/%(?![0-9a-f]{2})/iu.test(pathname) &&
    stripQueryAndFragment(htmlUrlText(specifier)) === pathname
    ? specifier
    : undefined;
};

const workerConstructorKind = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): "browser" | "node" | undefined => {
  const node = unwrapJavaScriptExpression(callee).node;
  const member =
    t.isMemberExpression(node) &&
    semanticStaticPropertyName(node.property, node.computed) === "Worker";
  const root = unwrapJavaScriptExpression(member ? node.object : node).node;
  if (!t.isIdentifier(root)) return undefined;
  const browserGlobal = member
    ? ["globalThis", "window", "self"].includes(root.name)
    : root.name === "Worker";
  if (browserGlobal && isUnmodifiedGlobalReference(node, bindings, "Worker"))
    return "browser";
  const binding = resolveSemanticBindingState(bindings, root, root.name);
  const [origin] = binding?.directOrigins ?? [];
  // Named ESM exports and module namespace exports are read-only. Default
  // imports and CommonJS objects can replace Worker, so their identity is unknown.
  return binding?.runtimeImport === true &&
    binding.definitions.length === 1 &&
    binding.directOrigins.length === 1 &&
    origin !== undefined &&
    (origin.specifier === "worker_threads" ||
      origin.specifier === "node:worker_threads") &&
    (member
      ? origin.importedPath.length === 0
      : origin.importedPath.length === 1 && origin.importedPath[0] === "Worker")
    ? "node"
    : undefined;
};

// Element factories such as jsx("audio", props) and createElement("video",
// props) carry the HTML media `preload` hint ("none", "metadata", "auto"),
// which never names an Electron preload script.
const noteMediaElementPreloads = (
  node: JavaScriptCallLike,
  accumulator: AnalysisAccumulator,
): void => {
  const props = node.arguments[1];
  if (!t.isObjectExpression(props)) return;
  for (const property of props.properties)
    if (
      t.isObjectProperty(property) &&
      semanticStaticPropertyName(property.key, property.computed) === "preload"
    )
      accumulator.mediaElementPreloads.add(property);
};

const requireCallSpecifier = (
  node: JavaScriptCallLike,
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
  node: JavaScriptCallLike,
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
  node: JavaScriptCallLike,
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
  ].map((literal) => literal[1] ?? literal[2] ?? "");
};

const inspectEndpointCall = (
  node: JavaScriptCallLike,
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
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const endpoint = endpointArgumentHelper(
    name,
    node.arguments,
    node.callee,
    receiverFact,
  );
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint,
      mechanism: `call:${name}`,
    });
};

/** Record tRPC procedures, tRPC link URLs and named GraphQL operations. */
export const inspectRpcNode = (node: t.Node, context: FindingContext): void => {
  const rpc = context.rpcScan.inspect(node);
  if (rpc !== undefined)
    addEndpoint(context, { node, kind: "network", ...rpc });
};

export const inspectRouteProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  const key = semanticStaticPropertyName(node.key, node.computed);
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
  if (semanticStaticPropertyName(node.key, node.computed) !== "preload") return;
  if (context.accumulator.mediaElementPreloads.has(node)) return;
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
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const storage =
    receiverFact === "local" ||
    receiverFact === "local-indexed-db" ||
    receiverFact === "local-cache-storage"
      ? undefined
      : receiverFact === "indexed-db"
        ? "indexed-db"
        : receiverFact === "cache-storage"
          ? "cache-storage"
          : storageKind(name);
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
  const specifier = input.specifier ?? null;
  const reference =
    specifier === null
      ? {
          specifier: null,
          expression: sourceSlice(context.source, input.node),
        }
      : { specifier, expression: null };
  addLocatedFinding(context, {
    collection: context.accumulator.references,
    key: `reference\0${input.kind}\0${reference.specifier ?? reference.expression}`,
    node: input.node,
    value: {
      kind: input.kind,
      ...reference,
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
      value: sanitizeEndpointCandidate(input.value),
      mechanism: input.mechanism,
      module_key: null,
      location: range(input.node),
    },
  });

export const addSourceMapDirectives = (
  source: string,
  comments: readonly t.Comment[],
  accumulator: AnalysisAccumulator,
): void => {
  // Read real comment tokens only; quoted text can contain identical markers.
  // Keep both current/legacy line annotations and minifier block annotations.
  for (const comment of comments) {
    const start = comment.start;
    const end = comment.end;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    )
      continue;
    const commentSource = source.slice(start, end);
    if (
      !(commentSource.startsWith("//") || commentSource.startsWith("/*")) ||
      !(commentSource[2] === "#" || commentSource[2] === "@")
    )
      continue;
    // Single-class searches avoid regex backtracking over unbounded whitespace
    // or inline URLs, which can exhaust the engine stack on two-byte strings.
    const nameOffset = commentSource.slice(3).search(/\S/u);
    if (nameOffset === -1) continue;
    const nameStart = 3 + nameOffset;
    if (!commentSource.startsWith("sourceMappingURL", nameStart)) continue;
    const nameEnd = nameStart + "sourceMappingURL".length;
    const equalsOffset = commentSource.slice(nameEnd).search(/\S/u);
    if (equalsOffset === -1) continue;
    const equalsStart = nameEnd + equalsOffset;
    if (!commentSource.startsWith("=", equalsStart)) continue;
    const urlOffset = commentSource.slice(equalsStart + 1).search(/\S/u);
    if (urlOffset === -1) continue;
    const declaredStart = equalsStart + 1 + urlOffset;
    const terminator = commentSource
      .slice(declaredStart)
      .search(commentSource.startsWith("//") ? /\s/u : /[\s*]/u);
    const declaredEnd =
      terminator === -1 ? commentSource.length : declaredStart + terminator;
    if (declaredEnd === declaredStart) continue;
    const declared = commentSource.slice(declaredStart, declaredEnd);
    const location = rangeForOffsets(source, start, start + declaredEnd);
    addFindingOnce(accumulator, `source-map\0${declared}`, () =>
      accumulator.sourceMaps.push({ declared_url: declared, location }),
    );
  }
};
