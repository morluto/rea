import { createHash } from "node:crypto";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import * as t from "@babel/types";

import type {
  JavaScriptBundlerRegistration,
  JavaScriptSourceRange,
  JavaScriptStaticAnalysis,
  JavaScriptStaticPathContext,
  JavaScriptStaticStorage,
} from "./javascriptStaticAnalysisTypes.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";
import { compareCodePoints } from "../canonicalOrdering.js";

export {
  propertyName,
  semanticStaticPropertyName,
} from "./javascriptAstValues.js";

/** Explicit result for source text that Babel cannot parse. */
export const failedJavaScriptStaticAnalysis = (): JavaScriptStaticAnalysis => ({
  parse_status: "failed",
  parse_error_count: 1,
  visited_ast_nodes: 0,
  references: [],
  endpoints: [],
  storage: [],
  bundler_registrations: [],
  role_paths: [],
  source_map_urls: [],
  vendors: [],
  electron: {
    browser_windows: [],
    context_bridge_apis: [],
    ipc: [],
    sender_validations: [],
    utility_processes: [],
    native_addon_bindings: [],
  },
  limitations: [
    "JavaScript source could not be parsed; absence of findings is not evidence of absence.",
    "JavaScript syntax was parsed as data and was never evaluated.",
  ],
});

/** Normalize one Babel call/new argument into the inert node shared by inspectors. */
export const argumentNode = (
  argument:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | null
    | undefined,
): t.Node | undefined =>
  argument !== null && t.isNode(argument) ? argument : undefined;

/** Recognize the runtime name for a Webpack/Rspack push call. */
export const chunkRuntime = (call: t.CallExpression): string | undefined => {
  if (
    !t.isMemberExpression(call.callee) &&
    !t.isOptionalMemberExpression(call.callee)
  )
    return undefined;
  if (
    semanticStaticPropertyName(call.callee.property, call.callee.computed) !==
    "push"
  )
    return undefined;
  return findChunkRuntime(call.callee.object);
};

const findChunkRuntime = (node: t.Node): string | undefined => {
  if (t.isIdentifier(node) && /(?:webpack|rspack)Chunk/iu.test(node.name))
    return node.name;
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const property = semanticStaticPropertyName(node.property, node.computed);
    if (/(?:webpack|rspack)Chunk/iu.test(property)) return property;
    return t.isNode(node.object) ? findChunkRuntime(node.object) : undefined;
  }
  if (t.isAssignmentExpression(node))
    return findChunkRuntime(node.left) ?? findChunkRuntime(node.right);
  if (t.isLogicalExpression(node) || t.isBinaryExpression(node))
    return findChunkRuntime(node.left) ?? findChunkRuntime(node.right);
  if (t.isParenthesizedExpression(node) || t.isTSAsExpression(node))
    return findChunkRuntime(node.expression);
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

/** Derive a literal or explicitly computed module key. */
export const modulePropertyName = (
  property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
): string =>
  t.isObjectMethod(property) || t.isObjectProperty(property)
    ? property.computed &&
      !t.isStringLiteral(property.key) &&
      !t.isNumericLiteral(property.key)
      ? `[computed@${String(property.start ?? -1)}]`
      : semanticStaticPropertyName(property.key, property.computed) ||
        `[unknown@${String(property.start ?? -1)}]`
    : `[unknown@${String(property.start ?? -1)}]`;

/** Read the factory-local bundler require parameter when declared. */
export const factoryRequireName = (
  factory: t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod,
): string | null => {
  const parameter = factory.params[2];
  return t.isIdentifier(parameter) ? parameter.name : null;
};

/** Collect all unique static literal values from an array. */
export const staticArrayValues = (
  array: t.ArrayExpression,
): {
  readonly values: readonly string[];
  readonly unknown: number;
} => {
  const staticValues = array.elements.flatMap((element) => {
    const value = argumentValue(element);
    return value === undefined ? [] : [value];
  });
  const values = [...new Set(staticValues)].sort(compareCodePoints);
  return {
    values,
    unknown: array.elements.length - staticValues.length,
  };
};

/** Resolve a path composed only from inert literal syntax. */
export const staticPath = (node: t.Node): string | undefined =>
  staticPathAt(node);

/** Classify whether inert path syntax is a module specifier or file expression. */
export const staticPathResolutionContext = (
  node: t.Node,
): JavaScriptStaticPathContext =>
  isFilesystemPathExpression(node)
    ? "filesystem-expression"
    : "module-specifier";

const staticPathAt = (node: t.Node): string | undefined => {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    const value = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
    return value;
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    const left = staticPathAt(node.left);
    const right = staticPathAt(node.right);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`;
  }
  if (t.isCallExpression(node) || t.isNewExpression(node))
    return staticCallPath(node);
  return undefined;
};

const staticCallPath = (
  node: t.CallExpression | t.NewExpression,
): string | undefined => {
  const name = calleeName(node.callee);
  if (name === "URL" || name.endsWith(".URL"))
    return isFileIdentity(argumentNode(node.arguments[1]))
      ? stringValue(node.arguments[0])
      : undefined;
  if (name === "fileURLToPath" || name.endsWith(".fileURLToPath")) {
    return staticFileUrlPath(argumentNode(node.arguments[0]));
  }
  if (
    (name === "dirname" || name.endsWith(".dirname")) &&
    isFileIdentity(argumentNode(node.arguments[0]))
  )
    return "";
  if (name.endsWith(".resolve"))
    return name === "win32.resolve" || name.endsWith(".win32.resolve")
      ? undefined
      : staticResolvedPath(node);
  if (!name.endsWith(".join") && name !== "join") return undefined;
  const parts: string[] = [];
  for (const argument of node.arguments) {
    if (isDirectoryIdentity(argumentNode(argument))) continue;
    const value = t.isNode(argument) ? staticPathAt(argument) : undefined;
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return parts.length === 0 ? undefined : posix.join(...parts);
};

const staticFileUrlPath = (
  argument: t.Node | undefined,
): string | undefined => {
  if (argument === undefined) return undefined;
  return isSourceFileUrl(argument)
    ? sourceRelativeFileUrlPath(argument)
    : staticPathAt(argument);
};

/** Project a known source-relative URL through the actual file URL decoder. */
const sourceRelativeFileUrlPath = (node: t.Node): string | undefined => {
  if (!isSourceFileUrl(node)) return undefined;
  const value = stringValue(node.arguments[0]);
  if (
    value === undefined ||
    (value.split(/[?#]/u, 1)[0] ?? "") === "" ||
    value !== value.trim() ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    value.startsWith("//") ||
    /%(?:2e|2f|5c)/iu.test(value.split(/[?#]/u, 1)[0] ?? "")
  )
    return undefined;
  // A sufficiently deep inert anchor preserves any leading parent segments
  // without using this host's cwd or inventing the application's directory.
  const directory = `/${"source/".repeat(value.split("/").length + 1)}`;
  try {
    const resolved = new URL(value, `file://${directory}entry.js`);
    const path = fileURLToPath(resolved, { windows: false });
    if (value.startsWith("/")) return path;
    const relative = posix.relative(directory, path) || ".";
    // Keep the established explicit source-directory observation spelling.
    return value.startsWith("./") &&
      relative !== "." &&
      !relative.startsWith("../")
      ? `./${relative}`
      : relative;
  } catch (cause: unknown) {
    // Malformed escapes and non-file URL forms remain unknown.
    void cause;
    return undefined;
  }
};

const isSourceFileUrl = (
  node: t.Node,
): node is t.CallExpression | t.NewExpression =>
  (t.isCallExpression(node) || t.isNewExpression(node)) &&
  (calleeName(node.callee) === "URL" ||
    calleeName(node.callee).endsWith(".URL")) &&
  isFileIdentity(argumentNode(node.arguments[1]));

const staticResolvedPath = (
  node: t.CallExpression | t.NewExpression,
): string | undefined => {
  const parts: (string | null)[] = [];
  for (const argument of node.arguments) {
    if (isDirectoryIdentity(argumentNode(argument))) {
      parts.push(null);
      continue;
    }
    const value = t.isNode(argument) ? staticPathAt(argument) : undefined;
    // Validate every argument, including those before the last anchor.
    if (value === undefined) return undefined;
    parts.push(value);
  }
  const anchor = parts.findLastIndex(
    (part) => part === null || posix.isAbsolute(part),
  );
  // Relative-only calls depend on the target process cwd, which is unknown.
  if (anchor === -1) return undefined;
  // A null anchor is the source directory; preserve its relative projection.
  const path = posix.join(
    ...parts.slice(anchor).filter((part) => part !== null),
  );
  return path === "/" ? path : path.replace(/\/$/u, "");
};

const isFilesystemPathExpression = (node: t.Node): boolean => {
  if (t.isStringLiteral(node)) return node.value.startsWith("/");
  if (isFileIdentity(node) || isDirectoryIdentity(node)) return true;
  if (t.isBinaryExpression(node, { operator: "+" }))
    return (
      isFilesystemPathExpression(node.left) ||
      isFilesystemPathExpression(node.right)
    );
  if (t.isCallExpression(node) || t.isNewExpression(node)) {
    const name = calleeName(node.callee);
    if (name.endsWith(".resolve") && staticCallPath(node) !== undefined)
      return true;
    if (name === "URL" || name.endsWith(".URL"))
      return isFileIdentity(argumentNode(node.arguments[1]));
    if (name === "fileURLToPath" || name.endsWith(".fileURLToPath"))
      return node.arguments.some((argument) => {
        const value = argumentNode(argument);
        return value !== undefined && isFilesystemPathExpression(value);
      });
    return node.arguments.some((argument) => {
      const value = argumentNode(argument);
      return value !== undefined && isFilesystemPathExpression(value);
    });
  }
  return false;
};

const isDirectoryIdentity = (node: t.Node | undefined): boolean => {
  if (t.isIdentifier(node, { name: "__dirname" })) return true;
  if (!t.isCallExpression(node) && !t.isNewExpression(node)) return false;
  const name = calleeName(node.callee);
  if (name === "URL" || name.endsWith(".URL"))
    return isFileIdentity(argumentNode(node.arguments[1]));
  return (
    (name === "dirname" || name.endsWith(".dirname")) &&
    isFileIdentity(argumentNode(node.arguments[0]))
  );
};

const isFileIdentity = (node: t.Node | undefined): boolean => {
  if (t.isIdentifier(node, { name: "__filename" })) return true;
  if (node === undefined) return false;
  if (
    t.isMemberExpression(node) &&
    t.isMetaProperty(node.object) &&
    node.object.meta.name === "import" &&
    node.object.property.name === "meta" &&
    semanticStaticPropertyName(node.property, node.computed) === "url"
  )
    return true;
  if (!t.isCallExpression(node)) return false;
  const name = calleeName(node.callee);
  return (
    (name === "fileURLToPath" || name.endsWith(".fileURLToPath")) &&
    isFileIdentity(argumentNode(node.arguments[0]))
  );
};

const XHR_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

/** An absolute HTTP(S)/WebSocket URL, or an absolute or relative path. */
const isRequestUrlLiteral = (value: string): boolean =>
  /^(?:https?|wss?):\/\//iu.test(value) ||
  value.startsWith("/") ||
  value.startsWith("./") ||
  value.startsWith("../");

/**
 * Browsing-context and document `open` take a URL or type first and a target
 * name second. The name is only a spelling, since `parent` or `self` may be a
 * local XHR binding, so it never overrides a literal HTTP method.
 */
const WINDOW_OPEN_CALL =
  /(?:^|\.)(?:window|self|globalThis|top|parent|opener|frames|document)\.open$/u;

/** Node `fs.open` flag strings, which are never request URLs. */
const FS_OPEN_FLAGS = new Set([
  "a",
  "a+",
  "as",
  "as+",
  "ax",
  "ax+",
  "r",
  "r+",
  "rs",
  "rs+",
  "sa",
  "sa+",
  "sr",
  "sr+",
  "w",
  "w+",
  "wx",
  "wx+",
  "xa",
  "xa+",
  "xw",
  "xw+",
]);

/** Reserved browsing-context names (ASCII case-insensitive). */
const BROWSING_CONTEXT_KEYWORDS = new Set([
  "_blank",
  "_parent",
  "_self",
  "_top",
]);

/**
 * Read `XMLHttpRequest.open(method, url)`. `fs.open(path, "r")` and
 * `window.open(url, "_blank")` share the callee name. A literal method must
 * be an HTTP method; with a computed method, the second literal is a URL
 * unless it is provably an fs flag or a browsing-context keyword, or the
 * receiver is spelled as a browsing context or storage. XHR normalizes the standard
 * methods' case; extension methods such as WebDAV `PROPFIND` are
 * conventionally uppercase tokens.
 */
const xhrOpenUrl = (
  name: string,
  methodNode: t.Node | null | undefined,
  urlNode: t.Node | null | undefined,
): string | undefined => {
  const url = stringValue(urlNode);
  if (url === undefined) return undefined;
  const method = stringValue(methodNode);
  // IndexedDB and Cache Storage `open` take a name and a version, so a
  // receiver spelled as storage needs a standard HTTP method literal.
  const storage = storageKind(name) !== undefined;
  if (method === undefined)
    return storage ||
      WINDOW_OPEN_CALL.test(name) ||
      FS_OPEN_FLAGS.has(url) ||
      BROWSING_CONTEXT_KEYWORDS.has(url.toLowerCase())
      ? undefined
      : url;
  return XHR_METHODS.has(method.toUpperCase()) ||
    (!storage && /^[A-Z][A-Z-]*$/u.test(method))
    ? url
    : undefined;
};

const KEYED_COLLECTION_CONSTRUCTORS = new Set([
  "FormData",
  "Headers",
  "Map",
  "Set",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
]);

/**
 * Whether a get/delete receiver is spelled as a keyed collection: a
 * constructed Map, Set, Headers, FormData, or URLSearchParams, or a
 * `headers`/`searchParams` property. Spelling alone does not prove the
 * binding, so callers keep URL and path literals as requests.
 */
const isKeyedCollectionReceiver = (callee: t.Node): boolean => {
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const receiver = callee.object;
  if (t.isNewExpression(receiver))
    return (
      t.isIdentifier(receiver.callee) &&
      KEYED_COLLECTION_CONSTRUCTORS.has(receiver.callee.name)
    );
  if (
    !t.isMemberExpression(receiver) &&
    !t.isOptionalMemberExpression(receiver)
  )
    return false;
  const property = semanticStaticPropertyName(
    receiver.property,
    receiver.computed,
  );
  return property === "headers" || property === "searchParams";
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
  callee: t.Node,
): string | undefined => {
  if (name === "fetch" || name.endsWith(".fetch") || name === "WebSocket")
    return stringValue(args[0]);
  if (name.endsWith(".open")) return xhrOpenUrl(name, args[0], args[1]);
  const method = ["get", "post", "put", "patch", "delete", "request"].find(
    (candidate) => name === candidate || name.endsWith(`.${candidate}`),
  );
  if (method !== undefined) {
    const value = stringValue(args[0]);
    // Only get and delete also belong to the keyed-collection APIs, whose
    // keys are header, field, and parameter names rather than URLs or paths.
    return value !== undefined &&
      (method === "get" || method === "delete") &&
      !isRequestUrlLiteral(value) &&
      isKeyedCollectionReceiver(callee)
      ? undefined
      : value;
  }
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

/** Produce a dotted callee name from member syntax. */
export const calleeName = (node: t.Node): string => {
  const segments: string[] = [];
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    // Dynamic keys retain their syntax identity instead of inventing a name.
    segments.push(memberPropertyName(node));
    if (!t.isNode(node.object)) break;
    node = node.object;
  }
  const base = t.isIdentifier(node)
    ? node.name
    : t.isImport(node)
      ? "import"
      : "";
  segments.push(base);
  segments.reverse();
  const first = segments.findIndex((segment) => segment !== "");
  return first === -1 ? "" : segments.slice(first).join(".");
};

/** Read a member property only when its syntax commits an exact name. */
const memberPropertyName = (
  node: t.MemberExpression | t.OptionalMemberExpression,
): string =>
  node.computed &&
  !t.isStringLiteral(node.property) &&
  !t.isNumericLiteral(node.property)
    ? `[computed@${String(node.property.start ?? -1)}]`
    : semanticStaticPropertyName(node.property, node.computed);

/**
 * Return a string literal value without evaluating an expression. A template
 * literal without substitutions denotes the same exact string.
 */
export const stringValue = (
  node: t.Node | null | undefined,
): string | undefined => {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/** Return a string or numeric argument literal. */
export const argumentValue = (
  node: t.Node | null | undefined,
): string | undefined =>
  t.isNumericLiteral(node) ? String(node.value) : stringValue(node);

/** Prefix a static argument value when one is available. */
export const prefixedArgument = (
  prefix: string,
  node: t.Node | null | undefined,
): string | undefined => {
  const value = argumentValue(node);
  return value === undefined ? undefined : `${prefix}${value}`;
};

/** Retain the exact source span represented by an AST node. */
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

/** Compare two exact source ranges. */
export const sourceRangesEqual = (
  left: JavaScriptSourceRange | null,
  right: JavaScriptSourceRange,
): boolean =>
  left !== null &&
  left.start.line === right.start.line &&
  left.start.column === right.start.column &&
  left.end.line === right.end.line &&
  left.end.column === right.end.column;

const pointForOffset = (source: string, offset: number) => {
  const before = source.slice(0, offset);
  // Match JavaScript line terminators, treating CRLF as a single newline.
  const lines = before.split(/\r\n|[\n\r\u2028\u2029]/u);
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
};

/** Observe known bundler/framework marker strings without claiming dependency use. */
export const detectVendors = (source: string): string[] =>
  vendorPatterns.flatMap(({ name, patterns }) =>
    patterns.some((pattern) => source.includes(pattern)) ? [name] : [],
  );

/** Commit the static semantic content used to deduplicate registrations. */
export const registrationKey = (
  registration: JavaScriptBundlerRegistration,
): string =>
  `${registration.runtime}\0${registration.chunk_keys.join("\0")}\0${String(registration.unknown_chunk_keys)}\0${registration.modules.map(({ module_key: key, source_sha256: digest }) => `${key}:${digest}`).join("\0")}`;

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
  { name: "Rollup", patterns: ["ROLLUP_FILE_URL", "import.meta.ROLLUP"] },
  { name: "esbuild", patterns: ["__commonJS", "__esm"] },
  { name: "React", patterns: ["React.createElement", "react/jsx-runtime"] },
  { name: "Vue", patterns: ["__VUE__", "createApp("] },
  { name: "Next.js", patterns: ["__NEXT_DATA__", "/_next/"] },
  { name: "Angular", patterns: ["ɵɵdefineComponent"] },
  { name: "Svelte", patterns: ["svelte/internal"] },
] as const;
