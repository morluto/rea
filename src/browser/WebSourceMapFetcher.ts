import * as t from "@babel/types";
import {
  decodeValidatedSourceMapLeaves,
  isBeforeSourceMapLeafStop,
  resolveSourceMapSource,
} from "../javascript/sourceMaps/DecodedSourceMap.js";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { isUrlLikeModuleSpecifier } from "../domain/webBundleAnalyzerAst.js";
import { analyzeParsedJavaScriptReferences } from "../domain/javascript/javascriptSemanticAnalysis.js";
import { traverseJavaScriptAst } from "../domain/javascript/javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import type {
  AnalyzeWebBundleInput,
  WebSourceMapItem,
  WebSourceMaps,
} from "../domain/webBundleAnalysis.js";
import { webSourceMapsSchema } from "../domain/webBundleAnalysis.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import { safeParseJson } from "../domain/safeJson.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import {
  inspectSourceMapValue,
  SourceMapFormatFailure,
  type SourceMapLeaf,
} from "../javascript/sourceMaps/SourceMapFormat.js";
import { WEB_SOURCE_MAP_LIMITS } from "../domain/webSourceLocation.js";
import {
  fetchSourceMapSafely,
  resolveSourceMapAddresses,
  SourceMapAddressPolicyError,
  type SourceMapResolver,
} from "./SourceMapSafeFetch.js";

export interface WebSourceMapRequest {
  readonly scriptKey: string;
  readonly declaredUrl: string;
  readonly fetchUrl: string;
}

interface SourceMapFetchHost {
  readonly fetch?: typeof fetch;
  /** Resolver seam for proving address policy without making a network call. */
  readonly resolve?: SourceMapResolver;
  /** Origins explicitly approved by the caller before provider-added defaults. */
  readonly explicitAllowedOrigins?: readonly string[];
  /** Fetch-operation deadline; injectable so boundary regressions stay fast. */
  readonly timeoutMs?: number;
  /** Maximum response bytes retained across this operation. */
  readonly maxResponseBytes?: number;
}

// Source maps are normally fetched as a small part of a larger inspection.
// Bound a stalled server to 30 seconds and bound raw map input retained for
// parsing to 64 MiB per inspection. Both limits apply at the network boundary;
// hitting either produces an explicit fetch_failed item, never truncated data.
const SOURCE_MAP_FETCH_TIMEOUT_MS = 30_000;
const SOURCE_MAP_RESPONSE_BYTES = 64 * 1024 * 1024;
const SOURCE_MAP_OUTPUT_BYTES = WEB_SOURCE_MAP_LIMITS.outputBytes;
const SOURCE_MAP_FAILURE_LIMITATION_RESERVE = 512;
const SOURCE_MAP_COLLECTION_ENVELOPE_RESERVE = 1_024;

type SourceMaps = WebSourceMaps;
type SourceMapItem = WebSourceMapItem;
type ParsedSourceMapItem = Extract<
  SourceMapItem,
  { status: "included" | "partial" }
>;
interface SourceMapDecodeContext {
  readonly signal: AbortSignal | undefined;
  readonly deadlineAt: number;
  readonly budget: {
    records: number;
    expandedBytes: number;
    resolvedSourceBytes: number;
  };
}

/** Fetch and validate approved source maps without browser credentials. */
export const fetchWebSourceMaps = async (
  requests: readonly WebSourceMapRequest[],
  input: AnalyzeWebBundleInput,
  signal?: AbortSignal,
  host: SourceMapFetchHost = {},
): Promise<SourceMaps> => {
  const items: SourceMapItem[] = [];
  const operationController = new AbortController();
  const timeout = setTimeout(
    () => operationController.abort(new SourceMapDeadlineError()),
    host.timeoutMs ?? SOURCE_MAP_FETCH_TIMEOUT_MS,
  );
  const abortFromCaller = (): void => operationController.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const operationSignal = operationController.signal;
  const deadlineAt =
    Date.now() + (host.timeoutMs ?? SOURCE_MAP_FETCH_TIMEOUT_MS);
  const budget = {
    retainedBytes: 0,
    deadlineAt,
    decodedRecords: {
      records: 0,
      expandedBytes: SOURCE_MAP_COLLECTION_ENVELOPE_RESERVE,
      resolvedSourceBytes: 0,
    },
  };
  let limitation: string | undefined;
  try {
    for (const request of requests) {
      if (signal?.aborted === true) throw signal.reason;
      const reservation = sourceMapFailureReservation(request) + 1;
      if (
        reservation >
        SOURCE_MAP_OUTPUT_BYTES - budget.decodedRecords.expandedBytes
      ) {
        const unprocessed = requests.length - items.length;
        limitation = `Source-map output budget was exhausted before processing ${String(unprocessed)} requested map${unprocessed === 1 ? "" : "s"}. Their results are unknown.`;
        break;
      }
      const expandedBytesBeforeItem = budget.decodedRecords.expandedBytes;
      budget.decodedRecords.expandedBytes += reservation;
      if (operationSignal.aborted || Date.now() >= deadlineAt) {
        items.push(
          emptySourceMapItem(
            request,
            "fetch_failed",
            "Source-map fetching exceeded its operation deadline.",
          ),
        );
        continue;
      }
      const item = await fetchOne(
        request,
        input,
        operationSignal,
        {
          ...host,
          explicitAllowedOrigins:
            host.explicitAllowedOrigins ?? input.allowed_origins,
        },
        budget,
      );
      if (item.artifact === null)
        budget.decodedRecords.expandedBytes =
          expandedBytesBeforeItem + reservation;
      items.push(item);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
  if (signal?.aborted === true) throw signal.reason;
  return webSourceMapsSchema.parse({
    status: sourceMapsStatus(items, limitation !== undefined),
    requested: requests.length,
    processed: items.length,
    items,
    ...(limitation === undefined ? {} : { limitation }),
  });
};

const sourceMapsStatus = (
  items: readonly SourceMapItem[],
  omitted: boolean,
): SourceMaps["status"] => {
  const retained = items.filter(
    ({ status }) => status === "included" || status === "partial",
  ).length;
  if (items.length === 0 || retained === 0) return "unavailable";
  if (omitted) return "partial";
  return retained === items.length &&
    !items.some(({ status }) => status === "partial")
    ? "included"
    : "partial";
};

class SourceMapDeadlineError extends Error {
  constructor() {
    super("Source-map fetching exceeded its operation deadline.");
    this.name = "SourceMapDeadlineError";
  }
}

class SourceMapSizeLimitError extends Error {
  constructor() {
    super("Source-map response exceeded the retained-byte budget.");
    this.name = "SourceMapSizeLimitError";
  }
}

class SourceMapEncodingError extends Error {
  constructor() {
    super("Source-map response is not valid UTF-8.");
    this.name = "SourceMapEncodingError";
  }
}

const fetchOne = async (
  request: WebSourceMapRequest,
  input: AnalyzeWebBundleInput,
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
  budget: {
    retainedBytes: number;
    deadlineAt: number;
    decodedRecords: {
      records: number;
      expandedBytes: number;
      resolvedSourceBytes: number;
    };
  },
): Promise<SourceMapItem> => {
  if (!approvedUrl(request.fetchUrl, input.allowed_origins))
    return emptySourceMapItem(
      request,
      "policy_filtered",
      "Declared source-map URL is outside the approved exact origins.",
    );
  try {
    const fetched = await fetchFollowingApprovedRedirects(
      request.fetchUrl,
      input.allowed_origins,
      signal,
      host,
    );
    if (fetched === undefined)
      return emptySourceMapItem(
        request,
        "policy_filtered",
        "A source-map redirect left the approved exact origins.",
      );
    try {
      const { response, fetchedUrl } = fetched;
      if (!response.ok) {
        await response.body?.cancel();
        return emptySourceMapItem(
          request,
          "fetch_failed",
          `Source-map server returned HTTP ${String(response.status)}.`,
        );
      }
      checkOperation(undefined, signal, budget.deadlineAt);
      return normalizeSourceMap(
        request,
        await readBoundedText(
          response,
          budget,
          host.maxResponseBytes ?? SOURCE_MAP_RESPONSE_BYTES,
          signal,
        ),
        fetchedUrl,
        {
          signal,
          deadlineAt: budget.deadlineAt,
          budget: budget.decodedRecords,
        },
      );
    } finally {
      await fetched.close().catch(() => undefined);
    }
  } catch (cause: unknown) {
    if (
      signal?.aborted === true &&
      !(signal.reason instanceof SourceMapDeadlineError)
    )
      throw cause;
    if (cause instanceof SourceMapEncodingError)
      return emptySourceMapItem(request, "invalid", cause.message);
    if (cause instanceof SourceMapAddressPolicyError)
      return emptySourceMapItem(request, "policy_filtered", cause.message);
    return emptySourceMapItem(
      request,
      "fetch_failed",
      cause instanceof SourceMapSizeLimitError
        ? cause.message
        : cause instanceof SourceMapDeadlineError
          ? cause.message
          : "Source-map fetch or validation failed.",
    );
  }
};

const fetchFollowingApprovedRedirects = async (
  initialUrl: string,
  allowedOrigins: readonly string[],
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
): Promise<
  | {
      response: Response;
      fetchedUrl: string;
      close: () => Promise<void>;
    }
  | undefined
> => {
  let current = initialUrl;
  const visited = new Set<string>();
  for (;;) {
    if (signal?.aborted === true) throw signal.reason;
    if (!approvedUrl(current, allowedOrigins)) return undefined;
    if (visited.has(current)) throw new Error("source_map_redirect_loop");
    visited.add(current);
    const init: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json, application/source-map+json;q=0.9",
      },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(signal === undefined ? {} : { signal }),
    };
    let response: Response;
    let close: () => Promise<void> = async () => undefined;
    if (host.fetch === undefined) {
      const safe = await promiseWithAbort(
        fetchSourceMapSafely(current, init, {
          ...(host.resolve === undefined ? {} : { resolve: host.resolve }),
          explicitAllowedOrigins: host.explicitAllowedOrigins ?? allowedOrigins,
        }),
        signal,
        ({ response, close }) => {
          void response.body?.cancel(signal?.reason).catch(() => undefined);
          void close().catch(() => undefined);
        },
      );
      response = safe.response;
      close = safe.close;
    } else {
      if (host.resolve !== undefined)
        await promiseWithAbort(
          resolveSourceMapAddresses(current, {
            resolve: host.resolve,
            explicitAllowedOrigins:
              host.explicitAllowedOrigins ?? allowedOrigins,
          }),
          signal,
        );
      response = await promiseWithAbort(host.fetch(current, init), signal);
    }
    if (signal !== undefined && signalIsAborted(signal)) {
      await response.body?.cancel(signal.reason).catch(() => undefined);
      await close().catch(() => undefined);
      throw signal.reason;
    }
    // Location is a redirect target only for the Fetch redirect statuses.
    // A 304 or another 3xx response must retain its own HTTP failure.
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, fetchedUrl: current, close };
    const location = response.headers.get("location");
    if (location === null) return { response, fetchedUrl: current, close };
    await response.body?.cancel();
    await close();
    current = new URL(location, current).href;
  }
};

const readBoundedText = async (
  response: Response,
  budget: { retainedBytes: number },
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal?.aborted === true) throw signal.reason;
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      const nextBytes = value?.byteLength ?? 0;
      if (budget.retainedBytes + bytes + nextBytes > maxBytes) {
        await reader.cancel(new SourceMapSizeLimitError());
        throw new SourceMapSizeLimitError();
      }
      if (value !== undefined) chunks.push(value);
      bytes += nextBytes;
    }
  } finally {
    // Aborting cancels the reader in readWithAbort. It owns the pending read
    // until that cancellation settles, so releasing the lock here can throw.
    if (signal?.aborted !== true) reader.releaseLock();
  }
  budget.retainedBytes += bytes;
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new SourceMapEncodingError();
  }
};

const readWithAbort = <T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> => {
  if (signal === undefined) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        void reader.cancel(cause).catch(() => undefined);
        reject(cause);
      },
    );
  });
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const promiseWithAbort = <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<T> => {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (response) => {
        if (settled || signal.aborted) {
          onLateValue?.(response);
          if (!settled) {
            settled = true;
            cleanup();
            reject(signal.reason);
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      },
    );
  });
};

const normalizeSourceMap = (
  request: WebSourceMapRequest,
  text: string,
  fetchedUrl: string,
  context: SourceMapDecodeContext,
): SourceMapItem => {
  const parsedJson = safeParseJson(text);
  if (!parsedJson.ok)
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map JSON is not a version 3 map.",
    );
  const retainedBytesBeforeMap = context.budget.expandedBytes;
  try {
    const check = (): void =>
      checkOperation(undefined, context.signal, context.deadlineAt);
    const inspected = inspectSourceMapValue(parsedJson.value, {
      profile: "browser-collection",
      budget: context.budget,
      check,
    });
    context.budget.expandedBytes =
      retainedBytesBeforeMap -
      sourceMapFailureReservation(request) +
      sourceMapSuccessReservation(request);
    consumeExpandedBytes(
      context.budget,
      jsonBytes(text) +
        artifactMetadataBytes("application/source-map+json", text) -
        4,
    );
    const sourcesByRaw = new Map<string, string>();
    const resolvedByRoot = new Map<string | null, Map<string, string>>();
    preflightResolvedSourceBytes(
      inspected.leaves,
      fetchedUrl,
      context.budget,
      resolvedByRoot,
      sourcesByRaw,
      check,
    );
    check();
    const decoded = decodeValidatedSourceMapLeaves(
      inspected.leaves,
      fetchedUrl,
      check,
    );
    const sourceJsonBytes = new Map<string, number>();
    const nameJsonBytes = new Map<string, number>();
    const originalSources: ParsedSourceMapItem["original_sources"] = [];
    for (const { leaf, resolvedSources } of decoded) {
      for (const [index, rawSource] of leaf.map.sources.entries()) {
        if ((index & 255) === 0) check();
        const resolved =
          resolvedSources[index] ?? rawSource ?? "[unknown-source]";
        const sanitized = cachedSanitized(sourcesByRaw, resolved);
        const content = leaf.map.sourcesContent?.[index] ?? null;
        consumeExpandedBytes(
          context.budget,
          cachedJsonBytes(sourceJsonBytes, sanitized) +
            sourceEntryOverheadBytes() +
            (originalSources.length === 0 ? 0 : 1) +
            (content === null
              ? 0
              : jsonBytes(content) +
                artifactMetadataBytes(sourceMediaType(rawSource), content) -
                4),
        );
        originalSources.push({
          source: sanitized,
          artifact:
            content === null
              ? null
              : createWebTextArtifact(content, sourceMediaType(rawSource)),
        });
      }
    }
    const mappings: ParsedSourceMapItem["mappings"] = [];
    for (const { leaf, rows, resolvedSources } of decoded)
      for (const [line, row] of rows.entries()) {
        if ((line & 255) === 0) check();
        for (const segment of row) {
          if (!isBeforeSourceMapLeafStop(leaf, line, segment[0])) continue;
          if (segment.length === 1) continue;
          const rawSource = leaf.map.sources[segment[1]];
          const resolved =
            resolvedSources[segment[1]] ?? rawSource ?? "[unknown-source]";
          const source = cachedSanitized(sourcesByRaw, resolved);
          const name =
            segment.length === 5 ? (leaf.map.names[segment[4]] ?? null) : null;
          const generatedLine = leaf.offset.line + line + 1;
          const generatedColumn =
            segment[0] + (line === 0 ? leaf.offset.column : 0);
          consumeExpandedBytes(
            context.budget,
            cachedJsonBytes(sourceJsonBytes, source) +
              (name === null ? 4 : cachedJsonBytes(nameJsonBytes, name)) +
              mappingRowBytes(
                generatedLine,
                generatedColumn,
                segment[2] + 1,
                segment[3],
              ) +
              (mappings.length === 0 ? 0 : 1),
          );
          mappings.push({
            generated_line: generatedLine,
            generated_column: generatedColumn,
            source,
            original_line: segment[2] + 1,
            original_column: segment[3],
            name,
          });
        }
      }
    const modules = originalModuleEdges(originalSources, check, (edge) =>
      consumeExpandedBytes(
        context.budget,
        Buffer.byteLength(JSON.stringify(edge)) + 1,
      ),
    );
    check();
    if (modules.incomplete.length > 0)
      consumeExpandedBytes(
        context.budget,
        jsonBytes(
          `Module edges are incomplete: ${modules.incomplete.length} of ${originalSources.filter(({ artifact }) => artifact !== null).length} original sources could not be parsed in full (${modules.incomplete.join(", ")}).`,
        ) - 4,
      );
    const parsed = {
      ...sourceMapContext(request),
      artifact: createWebTextArtifact(text, "application/source-map+json"),
      original_sources: originalSources,
      original_module_edges: modules.edges,
      mappings,
    };
    check();
    return modules.incomplete.length === 0
      ? { ...parsed, status: "included", limitation: null }
      : {
          ...parsed,
          status: "partial",
          limitation: `Module edges are incomplete: ${modules.incomplete.length} of ${originalSources.filter(({ artifact }) => artifact !== null).length} original sources could not be parsed in full (${modules.incomplete.join(", ")}).`,
        };
  } catch (cause: unknown) {
    // Failed maps publish no artifact or mapping rows. Release their output
    // reservation while keeping cumulative fetch and decoder-work accounting.
    context.budget.expandedBytes = retainedBytesBeforeMap;
    if (cause instanceof SourceMapFormatFailure && cause.reason === "limit")
      return emptySourceMapItem(request, "fetch_failed", cause.message);
    if (
      context.signal?.aborted === true ||
      cause instanceof SourceMapDeadlineError
    )
      throw cause;
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map JSON mappings could not be decoded safely.",
    );
  }
};

interface OriginalModuleEdges {
  readonly edges: ParsedSourceMapItem["original_module_edges"];
  /** Original sources whose dependency edges may be incomplete. */
  readonly incomplete: readonly string[];
}

const originalModuleEdges = (
  sources: ParsedSourceMapItem["original_sources"],
  check: () => void,
  beforeEdge: (
    edge: ParsedSourceMapItem["original_module_edges"][number],
  ) => void,
): OriginalModuleEdges => {
  const edges: ParsedSourceMapItem["original_module_edges"] = [];
  const seen = new Set<string>();
  const incomplete: string[] = [];
  for (const source of sources) {
    check();
    if (source.artifact === null) continue;
    const parsed = parseJavaScriptSource(source.artifact.text);
    check();
    if (parsed === null) {
      incomplete.push(source.source);
      continue;
    }
    // A recovered program still yields the imports it did parse, but nodes
    // after an unrecoverable point are missing, so the edges are a subset.
    if (parsed.errors.length > 0) incomplete.push(source.source);
    let unboundRequires: ReadonlySet<string> | undefined;
    traverseJavaScriptAst(parsed, {
      enter: (node) => {
        check();
        const dependency = originalDependency(node);
        if (dependency === null) return;
        const { kind, specifier } = dependency;
        if (kind === "require" && t.isCallExpression(node)) {
          unboundRequires ??= new Set(
            analyzeParsedJavaScriptReferences(parsed, "require")
              .filter(
                ({ role, resolution }) =>
                  role === "read" && resolution === "unbound",
              )
              .map(
                ({ location }) =>
                  `${String(location.start.line)}:${String(location.start.column)}`,
              ),
          );
          const location = node.callee.loc?.start;
          if (
            location === undefined ||
            !unboundRequires.has(
              `${String(location.line)}:${String(location.column)}`,
            )
          )
            return;
        }
        const key = `${source.source}\0${kind}\0${specifier}`;
        if (seen.has(key)) return;
        seen.add(key);
        const edge = {
          from_source: source.source,
          kind,
          specifier,
          resolved_source: resolveOriginalSource(specifier, source.source),
        };
        beforeEdge(edge);
        edges.push(edge);
      },
    });
  }
  return { edges, incomplete };
};

const checkOperation = (
  callerSignal: AbortSignal | undefined,
  operationSignal: AbortSignal | undefined,
  deadlineAt: number,
): void => {
  if (callerSignal?.aborted === true) throw callerSignal.reason;
  if (operationSignal?.aborted === true) throw operationSignal.reason;
  if (Date.now() >= deadlineAt) throw new SourceMapDeadlineError();
};

const approvedUrl = (
  value: string,
  allowedOrigins: readonly string[],
): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      allowedOrigins.includes(parsed.origin)
    );
  } catch (cause: unknown) {
    // Non-URL input is not an approved source-map URL.
    void cause;
    return false;
  }
};

const sourceMapContext = (request: WebSourceMapRequest) => ({
  script_key: request.scriptKey,
  declared_url: request.declaredUrl,
});

const emptySourceMapItem = (
  request: WebSourceMapRequest,
  status: Extract<SourceMapItem, { readonly artifact: null }>["status"],
  limitation: string,
): Extract<SourceMapItem, { readonly artifact: null }> => ({
  ...sourceMapContext(request),
  status,
  artifact: null,
  original_sources: [],
  original_module_edges: [],
  mappings: [],
  limitation,
});

const sanitizeSource = (value: string): string => {
  try {
    return sanitizeBrowserUrl(new URL(value).href).url;
  } catch (cause: unknown) {
    // Non-URL sources are preserved verbatim.
    void cause;
    return value;
  }
};

const preflightResolvedSourceBytes = (
  leaves: readonly SourceMapLeaf[],
  mapUrl: string,
  budget: { readonly expandedBytes: number; resolvedSourceBytes: number },
  resolvedByRoot: Map<string | null, Map<string, string>>,
  sanitizedByResolved: Map<string, string>,
  check: () => void,
): void => {
  let estimate = budget.expandedBytes;
  let resolvedBytes = budget.resolvedSourceBytes;
  for (const { map } of leaves) {
    let sourcesForRoot = resolvedByRoot.get(map.sourceRoot ?? null);
    if (sourcesForRoot === undefined) {
      sourcesForRoot = new Map();
      resolvedByRoot.set(map.sourceRoot ?? null, sourcesForRoot);
    }
    for (const source of map.sources) {
      check();
      const sourceKey = source ?? "";
      let resolved = sourcesForRoot.get(sourceKey);
      if (resolved === undefined)
        resolved = resolveSourceMapSource(source, map.sourceRoot, mapUrl);
      const bytes = Buffer.byteLength(resolved, "utf8");
      if (bytes > SOURCE_MAP_RESPONSE_BYTES - resolvedBytes)
        throw resolvedSourceLimitFailure();
      resolvedBytes += bytes;
      sourcesForRoot.set(sourceKey, resolved);
      const sanitized = cachedSanitized(sanitizedByResolved, resolved);
      estimate += jsonBytes(sanitized);
      if (estimate > WEB_SOURCE_MAP_LIMITS.outputBytes)
        throw expandedOutputFailure();
    }
  }
  budget.resolvedSourceBytes = resolvedBytes;
};

const consumeExpandedBytes = (
  budget: { expandedBytes: number },
  bytes: number,
): void => {
  if (bytes > WEB_SOURCE_MAP_LIMITS.outputBytes - budget.expandedBytes)
    throw expandedOutputFailure();
  budget.expandedBytes += bytes;
};

const expandedOutputFailure = (): SourceMapFormatFailure =>
  new SourceMapFormatFailure(
    "limit",
    `Expanded source-map evidence exceeds the ${WEB_SOURCE_MAP_LIMITS.outputBytes / (1024 * 1024)} MiB public representation budget.`,
  );

const resolvedSourceLimitFailure = (): SourceMapFormatFailure =>
  new SourceMapFormatFailure(
    "limit",
    `Resolved source-map identities exceed the ${SOURCE_MAP_RESPONSE_BYTES / (1024 * 1024)} MiB decoder representation budget.`,
  );

const jsonBytes = (value: string): number => {
  let bytes = 0;
  for (const part of jsonParts(value)) bytes += Buffer.byteLength(part, "utf8");
  return bytes;
};

const artifactMetadataBytes = (mediaType: string, text: string): number =>
  Buffer.byteLength(
    JSON.stringify({
      sha256: "0".repeat(64),
      bytes: Buffer.byteLength(text),
      media_type: mediaType,
      charset: "utf-8",
      text: "",
    }),
  ) - 2;

const sourceMapFailureReservation = (request: WebSourceMapRequest): number => {
  const envelope = emptySourceMapItem(
    { ...request, declaredUrl: "", scriptKey: "" },
    "fetch_failed",
    "x".repeat(SOURCE_MAP_FAILURE_LIMITATION_RESERVE),
  );
  return (
    Buffer.byteLength(JSON.stringify(envelope)) -
    4 +
    jsonBytes(request.declaredUrl) +
    jsonBytes(request.scriptKey)
  );
};

const sourceMapSuccessReservation = (request: WebSourceMapRequest): number => {
  const context = sourceMapContext({
    ...request,
    declaredUrl: "",
    scriptKey: "",
  });
  const envelope = {
    ...context,
    status: "included",
    artifact: null,
    original_sources: [],
    original_module_edges: [],
    mappings: [],
    limitation: null,
  };
  return (
    Buffer.byteLength(JSON.stringify(envelope)) -
    4 +
    jsonBytes(request.declaredUrl) +
    jsonBytes(request.scriptKey)
  );
};

const sourceEntryOverheadBytes = (): number =>
  Buffer.byteLength('{"source":,"artifact":null}');

const cachedJsonBytes = (cache: Map<string, number>, value: string): number => {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const bytes = jsonBytes(value);
  cache.set(value, bytes);
  return bytes;
};

const cachedSanitized = (cache: Map<string, string>, value: string): string => {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const sanitized = sanitizeSource(value);
  cache.set(value, sanitized);
  return sanitized;
};

const mappingRowBytes = (
  generatedLine: number,
  generatedColumn: number,
  originalLine: number,
  originalColumn: number,
): number =>
  Buffer.byteLength(
    `{"generated_line":${String(generatedLine)},"generated_column":${String(generatedColumn)},"source":,"original_line":${String(originalLine)},"original_column":${String(originalColumn)},"name":}`,
  );

const resolveOriginalSource = (
  specifier: string,
  base: string,
): string | null => {
  if (!isUrlLikeModuleSpecifier(specifier)) return null;
  try {
    return sanitizeSource(new URL(specifier, base).href);
  } catch (cause: unknown) {
    // Unresolvable source specifiers are represented by null.
    void cause;
    return null;
  }
};

const sourceMediaType = (source: string | null): string =>
  source?.endsWith(".ts") ||
  source?.endsWith(".tsx") ||
  source?.endsWith(".mts") ||
  source?.endsWith(".cts")
    ? "text/typescript"
    : "text/javascript";

const originalDependency = (
  node: t.Node,
): {
  readonly kind: ParsedSourceMapItem["original_module_edges"][number]["kind"];
  readonly specifier: string;
} | null => {
  if (
    t.isImportDeclaration(node) ||
    t.isExportAllDeclaration(node) ||
    t.isExportNamedDeclaration(node)
  )
    return node.source === null || node.source === undefined
      ? null
      : { kind: "static_import", specifier: node.source.value };
  if (t.isImportExpression(node) && t.isStringLiteral(node.source))
    return { kind: "dynamic_import", specifier: node.source.value };
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: "require" }) &&
    t.isStringLiteral(node.arguments[0])
  )
    return { kind: "require", specifier: node.arguments[0].value };
  // `import x = require("m")` is only legal at module top level and always
  // refers to the host loader, so it needs no unbound-`require` check. The
  // `moduleReference` is an entity name for a local alias instead, which
  // declares no dependency.
  if (
    t.isTSImportEqualsDeclaration(node) &&
    t.isTSExternalModuleReference(node.moduleReference)
  )
    return {
      kind: "require",
      specifier: node.moduleReference.expression.value,
    };
  return null;
};
