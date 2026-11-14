import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  staticObjectProperty,
  staticObjectPropertyNames,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/** RFC 9110 `token`, the grammar of methods, header names and subprotocols. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/** Fetch's forbidden methods, matched byte-case-insensitively. */
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

const WEBSOCKET_SCHEMES = new Set(["ws:", "wss:", "http:", "https:"]);

const literalString = (node: t.Node | undefined): string | undefined => {
  if (node === undefined || t.isSpreadElement(node)) return undefined;
  const literal = readExactJavaScriptLiteral(node);
  return literal.found && typeof literal.value === "string"
    ? literal.value
    : undefined;
};

/** Whether an absolute URL literal names a user or password. */
const carriesCredentials = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.username !== "" || parsed.password !== "";
};

/** A body member proven present and not null or undefined. */
const provenBody = (node: t.Node): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  const literal = readExactJavaScriptLiteral(value);
  if (literal.found) return literal.value !== null;
  return (
    t.isTemplateLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isNewExpression(value) ||
    t.isNumericLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isRegExpLiteral(value)
  );
};

/**
 * The Request constructor refuses these before any fetch starts, so `fetch`
 * returns a rejected promise and sends nothing. Measured on Node 24.22.1 (undici),
 * which follows the Fetch standard that browsers implement:
 *
 *   a URL with a user name or password            -> TypeError
 *   method "G ET" / "" / "GET\n"                   -> TypeError, not a token
 *   method "CONNECT" / "connect" / "TRACE" / "Track" -> TypeError, forbidden
 *   GET or HEAD (any case, or the default) with a body that is not null
 *   or undefined, including ""                    -> TypeError
 *   a header name that is not a token, such as "a b", "" or "x-é" -> TypeError
 *
 * Only a string URL proves the default GET; a Request object may carry its own method.
 */
const fetchRefused = (node: t.Node): boolean => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const [input, init] = node.arguments;
  const url = literalString(input);
  if (url !== undefined && carriesCredentials(url)) return true;
  if (init === undefined || t.isSpreadElement(init)) return false;
  const options = unwrapJavaScriptExpression(init).node;
  if (!t.isObjectExpression(options)) return false;
  const methodMember = staticObjectProperty(options, "method");
  const method =
    methodMember.status === "explicit"
      ? literalString(methodMember.value)
      : methodMember.status === "missing" && url !== undefined
        ? "GET"
        : undefined;
  if (method !== undefined) {
    if (!TOKEN.test(method)) return true;
    const upper = method.toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) return true;
    const body = staticObjectProperty(options, "body");
    if (
      (upper === "GET" || upper === "HEAD") &&
      body.status === "explicit" &&
      provenBody(body.value)
    )
      return true;
  }
  const headers = staticObjectProperty(options, "headers");
  if (headers.status !== "explicit") return false;
  const record = unwrapJavaScriptExpression(headers.value).node;
  if (!t.isObjectExpression(record)) return false;
  const names = staticObjectPropertyNames(record);
  return (
    names.status !== "missing" &&
    names.status !== "dynamic" &&
    names.names.some((name) => !TOKEN.test(name))
  );
};

/**
 * The WebSocket constructor throws a SyntaxError before it opens a connection.
 * Measured on Node 24.22.1 (undici), which follows the WHATWG WebSockets
 * standard that browsers implement:
 *
 *   a URL with a fragment, even an empty one or a relative one -> SyntaxError
 *   an absolute URL whose scheme is not ws, wss, http or https  -> SyntaxError
 *   a subprotocol that is not a token, such as "", "a b", "a/b" or "é" -> SyntaxError
 *   the same subprotocol twice                                   -> SyntaxError
 *
 * A relative URL without a fragment stays: a browser resolves it against the
 * document. A non-string subprotocol becomes its string form, so it stays too.
 */
const webSocketRefused = (node: t.Node): boolean => {
  if (!t.isNewExpression(node)) return false;
  const [target, protocols] = node.arguments;
  const url = literalString(target);
  if (url !== undefined) {
    // The URL parser treats any "#" as the start of the fragment.
    if (url.includes("#")) return true;
    if (URL.canParse(url) && !WEBSOCKET_SCHEMES.has(new URL(url).protocol))
      return true;
  }
  if (protocols === undefined || t.isSpreadElement(protocols)) return false;
  const value = unwrapJavaScriptExpression(protocols).node;
  const single = literalString(value);
  if (single !== undefined) return !TOKEN.test(single);
  if (!t.isArrayExpression(value)) return false;
  const known = value.elements.flatMap((element) => {
    const name = literalString(element ?? undefined);
    return name === undefined ? [] : [name];
  });
  return (
    known.some((name) => !TOKEN.test(name)) ||
    new Set(known).size !== known.length
  );
};

/**
 * Whether a host request is refused while it is constructed, so nothing is sent.
 * Only `fetch` and `WebSocket` are judged here; other methods keep their own rules.
 */
export const hostRefusesJavaScriptRequest = (
  node: t.Node,
  method: string,
): boolean =>
  method === "fetch"
    ? fetchRefused(node)
    : method === "WebSocket"
      ? webSocketRefused(node)
      : false;
