import { createHash } from "node:crypto";
import { posix } from "node:path";

import * as t from "@babel/types";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import type {
  JavaScriptBundlerRegistration,
  JavaScriptSourceRange,
  JavaScriptStaticAnalysis,
  JavaScriptStaticStorage,
} from "./javascriptStaticAnalysisTypes.js";

/** Explicit result for source text that Babel cannot parse. */
export const failedJavaScriptStaticAnalysis = (): JavaScriptStaticAnalysis => ({
  parse_status: "failed",
  parse_error_count: 1,
  visited_ast_nodes: 0,
  dropped_findings: 0,
  references: [],
  endpoints: [],
  storage: [],
  bundler_registrations: [],
  role_paths: [],
  source_map_urls: [],
  vendors: [],
  limitations: [
    "JavaScript source could not be parsed; absence of findings is not evidence of absence.",
    "JavaScript syntax was parsed as data and was never evaluated.",
  ],
});

/** Recognize the bounded runtime name for a Webpack/Rspack push call. */
export const chunkRuntime = (call: t.CallExpression): string | undefined => {
  if (
    !t.isMemberExpression(call.callee) &&
    !t.isOptionalMemberExpression(call.callee)
  )
    return undefined;
  if (propertyName(call.callee.property) !== "push") return undefined;
  return findChunkRuntime(call.callee.object, 0);
};

const findChunkRuntime = (node: t.Node, depth: number): string | undefined => {
  if (depth >= 128) return undefined;
  if (t.isIdentifier(node) && /(?:webpack|rspack)Chunk/iu.test(node.name))
    return node.name.slice(0, 4_096);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const property = propertyName(node.property);
    if (/(?:webpack|rspack)Chunk/iu.test(property))
      return property.slice(0, 4_096);
    return t.isNode(node.object)
      ? findChunkRuntime(node.object, depth + 1)
      : undefined;
  }
  if (t.isAssignmentExpression(node))
    return (
      findChunkRuntime(node.left, depth + 1) ??
      findChunkRuntime(node.right, depth + 1)
    );
  if (t.isLogicalExpression(node) || t.isBinaryExpression(node))
    return (
      findChunkRuntime(node.left, depth + 1) ??
      findChunkRuntime(node.right, depth + 1)
    );
  if (t.isParenthesizedExpression(node) || t.isTSAsExpression(node))
    return findChunkRuntime(node.expression, depth + 1);
  return undefined;
};

/** Return a literal function factory from one module-table property. */
export const moduleFactory = (
  property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
):
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | undefined => {
  if (t.isObjectMethod(property)) return property;
  if (
    t.isObjectProperty(property) &&
    (t.isFunctionExpression(property.value) ||
      t.isArrowFunctionExpression(property.value))
  )
    return property.value;
  return undefined;
};

/** Derive a bounded literal or explicitly computed module key. */
export const modulePropertyName = (
  property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
): string =>
  t.isObjectMethod(property) || t.isObjectProperty(property)
    ? property.computed &&
      !t.isStringLiteral(property.key) &&
      !t.isNumericLiteral(property.key)
      ? `[computed@${String(property.start ?? -1)}]`
      : propertyName(property.key).slice(0, 4_096) ||
        `[unknown@${String(property.start ?? -1)}]`
    : `[unknown@${String(property.start ?? -1)}]`;

/** Read the factory-local bundler require parameter when declared. */
export const factoryRequireName = (
  factory: t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod,
): string | null => {
  const parameter = factory.params[2];
  return t.isIdentifier(parameter) ? parameter.name.slice(0, 4_096) : null;
};

/** Collect bounded unique literal values and explicit omissions from an array. */
export const staticArrayValues = (
  array: t.ArrayExpression,
  maximum: number,
): {
  readonly values: readonly string[];
  readonly omitted: number;
  readonly unknown: number;
} => {
  const staticValues = array.elements.flatMap((element) => {
    const value = argumentValue(element);
    return value === undefined ? [] : [value.slice(0, 4_096)];
  });
  const values = [...new Set(staticValues)].sort(compareCodePoints);
  return {
    values: values.slice(0, maximum),
    omitted: Math.max(0, values.length - maximum),
    unknown: array.elements.length - staticValues.length,
  };
};

/** Resolve a bounded path composed only from inert literal syntax. */
export const staticPath = (node: t.Node): string | undefined =>
  staticPathAt(node, 0);

const staticPathAt = (node: t.Node, depth: number): string | undefined => {
  if (depth >= 128) return undefined;
  if (t.isStringLiteral(node)) return node.value.slice(0, 4_096);
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    const value = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
    return value?.slice(0, 4_096);
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    const left = staticPathAt(node.left, depth + 1);
    const right = staticPathAt(node.right, depth + 1);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`.slice(0, 4_096);
  }
  if (t.isCallExpression(node) || t.isNewExpression(node))
    return staticCallPath(node, depth);
  return undefined;
};

const staticCallPath = (
  node: t.CallExpression | t.NewExpression,
  depth: number,
): string | undefined => {
  const name = calleeName(node.callee);
  if (name === "URL" || name.endsWith(".URL"))
    return stringValue(node.arguments[0]);
  if (!name.endsWith(".join") && !name.endsWith(".resolve") && name !== "join")
    return undefined;
  const parts: string[] = [];
  for (const argument of node.arguments) {
    if (t.isIdentifier(argument, { name: "__dirname" })) continue;
    const value = t.isNode(argument)
      ? staticPathAt(argument, depth + 1)
      : undefined;
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return parts.length === 0 ? undefined : posix.join(...parts).slice(0, 4_096);
};

/** Select the literal URL argument for recognized network callees. */
export const endpointArgument = (
  name: string,
  args: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
): string | undefined => {
  if (name === "fetch" || name.endsWith(".fetch") || name === "WebSocket")
    return stringValue(args[0]);
  if (name.endsWith(".open") && stringValue(args[1]) !== undefined)
    return stringValue(args[1]);
  if (
    ["get", "post", "put", "patch", "delete", "request"].some(
      (method) => name === method || name.endsWith(`.${method}`),
    )
  )
    return stringValue(args[0]);
  if (name.endsWith("loadURL")) return stringValue(args[0]);
  return undefined;
};

/** Classify a recognized storage API call name. */
export const storageKind = (
  name: string,
): JavaScriptStaticStorage["kind"] | undefined => {
  if (name.includes("localStorage.")) return "local-storage";
  if (name.includes("sessionStorage.")) return "session-storage";
  if (name.endsWith("indexedDB.open")) return "indexed-db";
  if (name.endsWith("caches.open")) return "cache-storage";
  if (name === "Database" || name.endsWith(".Database")) return "sqlite";
  return undefined;
};

/** Produce a dotted bounded callee name from member syntax. */
export const calleeName = (node: t.Node): string => calleeNameAt(node, 0);

const calleeNameAt = (node: t.Node, depth: number): string => {
  if (depth >= 128) return "[deep]";
  if (t.isIdentifier(node)) return node.name.slice(0, 4_096);
  if (t.isImport(node)) return "import";
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const object = t.isNode(node.object)
      ? calleeNameAt(node.object, depth + 1)
      : "";
    const property = propertyName(node.property);
    return (object === "" ? property : `${object}.${property}`).slice(0, 4_096);
  }
  return "";
};

/** Read a literal property name without evaluating computed syntax. */
export const propertyName = (node: t.Node): string => {
  if (t.isIdentifier(node)) return node.name.slice(0, 4_096);
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value).slice(0, 4_096);
  return "";
};

/** Return a string literal value without evaluating an expression. */
export const stringValue = (
  node: t.Node | null | undefined,
): string | undefined =>
  t.isStringLiteral(node) ? node.value.slice(0, 4_096) : undefined;

/** Return a string or numeric argument literal. */
export const argumentValue = (
  node: t.Node | null | undefined,
): string | undefined => {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value).slice(0, 4_096);
  return undefined;
};

/** Prefix a static argument value when one is available. */
export const prefixedArgument = (
  prefix: string,
  node: t.Node | null | undefined,
): string | undefined => {
  const value = argumentValue(node);
  return value === undefined ? undefined : `${prefix}${value}`;
};

/** Retain the exact bounded source span represented by an AST node. */
export const sourceSlice = (source: string, node: t.Node): string =>
  typeof node.start !== "number" || typeof node.end !== "number"
    ? ""
    : source.slice(node.start, node.end);

/** Convert Babel locations into the stable graph source-range shape. */
export const range = (node: t.Node): JavaScriptSourceRange => ({
  start: {
    line: node.loc?.start.line ?? 1,
    column: node.loc?.start.column ?? 0,
  },
  end: {
    line: node.loc?.end.line ?? node.loc?.start.line ?? 1,
    column: node.loc?.end.column ?? node.loc?.start.column ?? 0,
  },
});

/** Convert exact text offsets into a source range. */
export const rangeForOffsets = (
  source: string,
  start: number,
  end: number,
): JavaScriptSourceRange => ({
  start: pointForOffset(source, start),
  end: pointForOffset(source, end),
});

const pointForOffset = (source: string, offset: number) => {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
};

/** Observe known bundler/framework marker strings without claiming dependency use. */
export const detectVendors = (source: string): string[] =>
  vendorPatterns.flatMap(({ name, patterns }) =>
    patterns.some((pattern) => source.includes(pattern)) ? [name] : [],
  );

/** Remove credentials, fragments, and query values from endpoint candidates. */
export const sanitizeCandidate = (value: string): string => {
  const bounded = value.slice(0, 4_096);
  try {
    const parsed = new URL(bounded, "https://rea.invalid");
    const sanitized = sanitizeBrowserUrl(parsed.href).url;
    return parsed.origin === "https://rea.invalid"
      ? sanitized.replace("https://rea.invalid", "")
      : sanitized;
  } catch {
    return bounded.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  }
};

/** Commit the static semantic content used to deduplicate registrations. */
export const registrationKey = (
  registration: JavaScriptBundlerRegistration,
): string =>
  `${registration.runtime}\0${registration.chunk_keys.join("\0")}\0${String(registration.omitted_chunk_keys)}\0${String(registration.unknown_chunk_keys)}\0${registration.modules.map(({ module_key: key, source_sha256: digest }) => `${key}:${digest}`).join("\0")}`;

/** Sort values by a deterministic unique semantic key. */
export const sortedUnique = <Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): Value[] =>
  [...new Map(values.map((value) => [key(value), value])).values()].sort(
    (left, right) => compareCodePoints(key(left), key(right)),
  );

/** Hash exact UTF-8 source text. */
export const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Compare strings by Unicode code point for canonical ordering. */
export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Recognized route-construction call suffixes. */
export const STATIC_ROUTE_CALL_NAMES = [
  "route",
  "addRoute",
  "useRoutes",
  "createBrowserRouter",
  "createHashRouter",
] as const;

const vendorPatterns = [
  { name: "webpack", patterns: ["__webpack_require__", "webpackChunk"] },
  { name: "Rspack", patterns: ["__webpack_require__.f", "rspackChunk"] },
  { name: "Vite", patterns: ["__vite__", "import.meta.hot"] },
  { name: "React", patterns: ["React.createElement", "react/jsx-runtime"] },
  { name: "Vue", patterns: ["__VUE__", "createApp("] },
  { name: "Next.js", patterns: ["__NEXT_DATA__", "/_next/"] },
  { name: "Angular", patterns: ["ɵɵdefineComponent"] },
  { name: "Svelte", patterns: ["svelte/internal"] },
] as const;
