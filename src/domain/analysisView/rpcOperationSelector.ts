import { parseExactJson } from "../exactJsonNumber.js";
import type { JsonValue } from "../jsonValue.js";
import { safeParseJson } from "../safeJson.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { isJson, isJsonLike, mediaTypeEssence } from "./recordedMediaType.js";
import {
  base64PrefixChars,
  readRecordedResponseBody,
  readRecordedResponseDeclaration,
} from "./recordedResponseBody.js";

/** Supported single-POST multiplexed RPC families. */
export const RPC_OPERATION_KINDS = [
  "graphql",
  "json-rpc",
  "batchexecute",
] as const;
export type RpcOperationKind = (typeof RPC_OPERATION_KINDS)[number];

/** Deterministic sub-route discriminator extracted from a multiplexed POST request. */
export interface RpcOperation {
  readonly kind: RpcOperationKind;
  readonly name: string;
}

/** Maximum character length of a discriminated RPC operation name or method identifier. */
export const RPC_OPERATION_NAME_LIMIT = 128;
/** Maximum UTF-8 request body size inspected for RPC operation discrimination. */
export const RPC_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
/** Maximum UTF-8 response body size admitted as an XSSI-guarded JSON response on script/text media types. */
export const XSSI_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
/** Maximum URL query string length inspected for batchexecute `rpcids`. */
export const RPC_QUERY_LIMIT_CHARS = 8 * 1024;

const XSSI_SCRIPT_ESSENCES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
]);

const isPlainObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAsciiAlphaOrUnderscore = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isBoundedRpcName = (
  value: unknown,
  validCode: (code: number, index: number) => boolean,
): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > RPC_OPERATION_NAME_LIMIT
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!validCode(value.charCodeAt(index), index)) return false;
  }
  return true;
};

/** GraphQL `Name` lexical grammar (`/[_A-Za-z][_0-9A-Za-z]* /`) bounded to 1..128 chars without regex backtracking. */
const isGraphqlOperationName = (value: unknown): value is string =>
  isBoundedRpcName(value, (code, index) =>
    index === 0
      ? isAsciiAlphaOrUnderscore(code)
      : isAsciiAlphaOrUnderscore(code) || isAsciiDigit(code),
  );

/** Non-empty printable ASCII JSON-RPC 2.0 method name bounded to 1..128 chars. */
const isJsonRpcMethodName = (value: unknown): value is string =>
  isBoundedRpcName(value, (code) => code >= 0x21 && code <= 0x7e);

/** Identifier-like Google `batchexecute` RPC ID bounded to 1..128 chars; commas and spaces never qualify. */
const isBatchExecuteRpcId = (value: unknown): value is string =>
  isBoundedRpcName(
    value,
    (code) =>
      isAsciiAlphaOrUnderscore(code) ||
      isAsciiDigit(code) ||
      code === 0x2d || // -
      code === 0x2e || // .
      code === 0x2f || // /
      code === 0x3a, // :
  );

const isGraphqlPath = (path: string): boolean =>
  path
    .toLowerCase()
    .split("/")
    .some((segment) => segment.includes("graphql"));

/** Whether a request path targets a Google `batchexecute` endpoint. */
export const isBatchExecutePath = (path: string): boolean => {
  const trimmed =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed === "/batchexecute" || trimmed.endsWith("/batchexecute");
};

const withinByteLimit = (text: string, limitBytes: number): boolean =>
  text.length <= limitBytes && Buffer.byteLength(text, "utf8") <= limitBytes;

const withinBodyByteLimit = (text: string): boolean =>
  withinByteLimit(text, RPC_REQUEST_BODY_LIMIT_BYTES);

const selectFromJsonObject = (
  root: Readonly<Record<string, unknown>>,
  path: string,
): RpcOperation | undefined => {
  if (root.jsonrpc === "2.0")
    return isJsonRpcMethodName(root.method)
      ? { kind: "json-rpc", name: root.method }
      : undefined;
  if (!isGraphqlOperationName(root.operationName)) return undefined;
  if (typeof root.query === "string")
    return withinBodyByteLimit(root.query)
      ? { kind: "graphql", name: root.operationName }
      : undefined;
  if (isPlainObject(root.extensions) || isGraphqlPath(path))
    return { kind: "graphql", name: root.operationName };
  return undefined;
};

type BatchExecuteBodyParse =
  | { readonly kind: "single"; readonly name: string }
  | { readonly kind: "ambiguous" | "invalid" };

const parseBatchExecuteEnvelope = (freqText: string): BatchExecuteBodyParse => {
  if (!withinBodyByteLimit(freqText)) return { kind: "invalid" };
  const parsed = safeParseJson(freqText);
  if (!parsed.ok || !Array.isArray(parsed.value) || parsed.value.length === 0)
    return { kind: "invalid" };
  const calls: unknown = parsed.value[0];
  if (!Array.isArray(calls) || calls.length === 0) return { kind: "invalid" };
  let selected: string | undefined;
  for (const tuple of calls) {
    if (!Array.isArray(tuple) || tuple.length === 0) return { kind: "invalid" };
    const rpcId: unknown = tuple[0];
    if (!isBatchExecuteRpcId(rpcId)) return { kind: "invalid" };
    if (selected === undefined) selected = rpcId;
    else if (selected !== rpcId) return { kind: "ambiguous" };
  }
  return selected === undefined
    ? { kind: "invalid" }
    : { kind: "single", name: selected };
};

const selectBatchExecuteFormValues = (
  freqs: readonly string[],
): RpcOperation | undefined => {
  let selected: string | undefined;
  for (const freq of freqs) {
    const parsed = parseBatchExecuteEnvelope(freq);
    if (parsed.kind !== "single") return undefined;
    if (selected === undefined) selected = parsed.name;
    else if (selected !== parsed.name) return undefined;
  }
  return selected === undefined
    ? undefined
    : { kind: "batchexecute", name: selected };
};

const selectBatchExecuteQueryRpcId = (
  query: string | null | undefined,
): string | undefined => {
  if (
    query === undefined ||
    query === null ||
    query.length === 0 ||
    query.length > RPC_QUERY_LIMIT_CHARS
  )
    return undefined;
  const search = query.startsWith("?") ? query.slice(1) : query;
  const ids = new URLSearchParams(search)
    .getAll("rpcids")
    .flatMap((raw) => raw.split(","))
    .filter((entry) => entry.length > 0);
  const first = ids[0];
  if (first === undefined || !isBatchExecuteRpcId(first)) return undefined;
  return ids.every((entry) => entry === first) ? first : undefined;
};

const isJsonCandidateMime = (essence: string | null): boolean =>
  essence === null ||
  isJson(essence) ||
  isJsonLike(essence) ||
  essence === "application/graphql";

const isFormCandidateMime = (essence: string | null, path: string): boolean =>
  essence === "application/x-www-form-urlencoded" ||
  essence === null ||
  isBatchExecutePath(path);

/** Extract an optional RPC operation discriminator from a recorded HTTP request with raw body text. */
export const selectRpcOperationFromText = (input: {
  readonly method: string;
  readonly path: string;
  readonly query?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
  readonly bodyText?: string | null | undefined;
}): RpcOperation | undefined => {
  if (input.method !== "POST") return undefined;
  const essence =
    input.mimeType === undefined || input.mimeType === null
      ? null
      : mediaTypeEssence(input.mimeType);
  const { bodyText } = input;
  if (bodyText !== undefined && bodyText !== null && bodyText.length > 0) {
    if (!withinBodyByteLimit(bodyText)) return undefined;
    const parsedJson =
      essence === "application/x-www-form-urlencoded"
        ? undefined
        : safeParseJson(bodyText);
    if (parsedJson?.ok === true)
      return isJsonCandidateMime(essence) && isPlainObject(parsedJson.value)
        ? selectFromJsonObject(parsedJson.value, input.path)
        : undefined;
    if (isFormCandidateMime(essence, input.path)) {
      const freqs = new URLSearchParams(bodyText).getAll("f.req");
      if (freqs.length > 0) return selectBatchExecuteFormValues(freqs);
    }
  }
  if (isBatchExecutePath(input.path)) {
    const rpcId = selectBatchExecuteQueryRpcId(input.query);
    if (rpcId !== undefined) return { kind: "batchexecute", name: rpcId };
  }
  return undefined;
};

/** Whether a response media type can carry JSON or an XSSI-guarded JSON/batchexecute payload. */
export const isXssiEligibleMediaType = (essence: string | null): boolean =>
  essence === null || isJsonLike(essence) || XSSI_SCRIPT_ESSENCES.has(essence);

const stripXssiGuard = (text: string): string | undefined => {
  if (!text.startsWith(")]}'")) return undefined;
  let at = 4;
  if (text[at] === ",") at += 1;
  if (text[at] === "\n") return text.slice(at + 1);
  if (text[at] === "\r" && text[at + 1] === "\n") return text.slice(at + 2);
  return undefined;
};

/** Whether text begins with a Google/Closure `)]}'\n` (or `)]}',\n`) XSSI prefix followed by a line break. */
export const hasXssiGuardPrefix = (text: string): boolean =>
  stripXssiGuard(text) !== undefined;

const isHorizontalOrVerticalSpace = (code: number): boolean =>
  code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;

const parseLengthPrefixedFrames = (body: string): JsonValue | undefined => {
  const frames: JsonValue[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    while (
      cursor < body.length &&
      isHorizontalOrVerticalSpace(body.charCodeAt(cursor))
    )
      cursor += 1;
    if (cursor >= body.length) break;
    const digitsStart = cursor;
    while (
      cursor < body.length &&
      isAsciiDigit(body.charCodeAt(cursor)) &&
      cursor - digitsStart <= 8
    )
      cursor += 1;
    const digitsCount = cursor - digitsStart;
    if (digitsCount === 0 || digitsCount > 8) return undefined;
    if (body[cursor] === "\r" && body[cursor + 1] === "\n") cursor += 2;
    else if (body[cursor] === "\n") cursor += 1;
    else return undefined;
    const frameLength = Number(
      body.slice(digitsStart, digitsStart + digitsCount),
    );
    if (!Number.isSafeInteger(frameLength) || frameLength <= 0)
      return undefined;
    if (cursor + frameLength > body.length) return undefined;
    const chunk = body.slice(cursor, cursor + frameLength);
    const parsed = parseExactJson(chunk);
    if (parsed === undefined) return undefined;
    frames.push(parsed);
    cursor += frameLength;
  }
  if (frames.length === 0) return undefined;
  return frames.length === 1 ? frames[0] : frames;
};

/** Parse exact JSON directly, or after stripping a leading `)]}'` XSSI prefix (including length-framed batchexecute chunks). */
export const parseXssiOrExactJson = (text: string): JsonValue | undefined => {
  const stripped = stripXssiGuard(text);
  if (stripped === undefined) return parseExactJson(text);
  const parsed = parseExactJson(stripped);
  return parsed === undefined ? parseLengthPrefixedFrames(stripped) : parsed;
};

/**
 * Shared XSSI JSON response eligibility and `64 KiB` size policy for manifest grouping and probe origin selection.
 * Returns `null` only when `reserveSourceChars` refuses the temporary budget.
 */
export const hasBoundedXssiJsonResponse = (
  record: WebNetworkCaptureRecord,
  essence: string | null,
  reserveSourceChars: (sourceChars: number) => boolean = () => true,
): boolean | null => {
  if (!isXssiEligibleMediaType(essence)) return false;
  const declaration = readRecordedResponseDeclaration(record.reported);
  const content = declaration?.content;
  if (typeof content?.text !== "string") return false;
  let sourceChars = 0;
  if (content.encoding === undefined) {
    if (
      !hasXssiGuardPrefix(content.text) ||
      !withinByteLimit(content.text, XSSI_RESPONSE_BODY_LIMIT_BYTES)
    )
      return false;
    sourceChars = content.text.length;
  } else if (content.encoding === "base64") {
    const binary = record.binary_fields.find(
      (field) =>
        field.pointer === "/response/content/text" &&
        field.state === "retained",
    );
    const encoded = binary?.content_base64 ?? null;
    if (
      encoded === null ||
      !encoded.startsWith("KV19J") ||
      encoded.length > base64PrefixChars(XSSI_RESPONSE_BODY_LIMIT_BYTES)
    )
      return false;
    sourceChars = encoded.length;
  } else return false;
  if (!reserveSourceChars(sourceChars)) return null;
  const decoded = readRecordedResponseBody(
    record,
    XSSI_RESPONSE_BODY_LIMIT_BYTES,
    declaration,
  );
  if (
    decoded.bodyText === null ||
    decoded.bodyEncoding === "base64" ||
    decoded.bodyCut === true ||
    !withinByteLimit(decoded.bodyText, XSSI_RESPONSE_BODY_LIMIT_BYTES) ||
    !hasXssiGuardPrefix(decoded.bodyText)
  )
    return false;
  return parseXssiOrExactJson(decoded.bodyText) !== undefined;
};
