import { AnyMap, eachMapping } from "@jridgewell/trace-mapping";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "../domain/webBundleAnalysis.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";

export interface WebSourceMapRequest {
  readonly scriptKey: string;
  readonly declaredUrl: string;
  readonly fetchUrl: string;
}

interface SourceMapFetchHost {
  readonly fetch: typeof fetch;
}

type SourceMaps = WebBundleAnalysis["observations"]["source_maps"];
type SourceMapItem = SourceMaps["items"][number];

/** Fetch and validate approved source maps without browser credentials. */
export const fetchWebSourceMaps = async (
  requests: readonly WebSourceMapRequest[],
  input: AnalyzeWebBundleInput,
  signal?: AbortSignal,
  host: SourceMapFetchHost = { fetch: globalThis.fetch },
): Promise<SourceMaps> => {
  const items: SourceMapItem[] = [];
  let remainingBytes = input.analysis_limits.max_total_source_map_bytes;
  for (const request of requests.slice(
    0,
    input.analysis_limits.max_source_maps,
  )) {
    if (signal?.aborted === true) throw signal.reason;
    if (remainingBytes === 0) break;
    const fetched = await fetchOne(request, {
      input,
      maximumBytes: Math.min(
        input.analysis_limits.max_source_map_bytes,
        remainingBytes,
      ),
      signal,
      host,
    });
    items.push(fetched.item);
    remainingBytes = Math.max(0, remainingBytes - fetched.bytesRead);
  }
  const included = items.filter(({ status }) => status === "included").length;
  const dropped = requests.length - items.length;
  const truncated =
    dropped > 0 || items.some(({ status }) => status === "truncated");
  return {
    status: truncated
      ? "truncated"
      : items.length === 0
        ? "unavailable"
        : included === items.length
          ? "included"
          : included > 0
            ? "partial"
            : "unavailable",
    requested: requests.length,
    processed: items.length,
    dropped,
    dropped_script_keys: requests
      .slice(items.length)
      .map(({ scriptKey }) => scriptKey),
    items,
  };
};

interface SourceMapFetchResult {
  readonly item: SourceMapItem;
  readonly bytesRead: number;
}

interface SourceMapFetchContext {
  readonly input: AnalyzeWebBundleInput;
  readonly maximumBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly host: SourceMapFetchHost;
}

const fetchOne = async (
  request: WebSourceMapRequest,
  context: SourceMapFetchContext,
): Promise<SourceMapFetchResult> => {
  const { input, maximumBytes, signal, host } = context;
  const base = emptyItem(request);
  if (!approvedUrl(request.fetchUrl, input.allowed_origins))
    return {
      item: {
        ...base,
        status: "policy_filtered",
        limitation:
          "Declared source-map URL is outside the approved exact origins.",
      },
      bytesRead: 0,
    };
  try {
    const response = await fetchFollowingApprovedRedirects(
      request.fetchUrl,
      input.allowed_origins,
      signal,
      host,
    );
    if (response === undefined)
      return {
        item: {
          ...base,
          status: "policy_filtered",
          limitation: "A source-map redirect left the approved exact origins.",
        },
        bytesRead: 0,
      };
    if (!response.ok)
      return {
        item: {
          ...base,
          status: "fetch_failed",
          limitation: `Source-map server returned HTTP ${String(response.status)}.`,
        },
        bytesRead: 0,
      };
    const body = await boundedResponseText(response, maximumBytes);
    return {
      item: normalizeSourceMap(request, body.text, input),
      bytesRead: body.bytes,
    };
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    return {
      item: {
        ...base,
        status: isLimitError(cause) ? "truncated" : "fetch_failed",
        limitation: isLimitError(cause)
          ? "Source-map response exceeded the remaining approved byte budget."
          : "Source-map fetch or validation failed.",
      },
      bytesRead: cause instanceof SourceMapByteLimitError ? cause.bytesRead : 0,
    };
  }
};

const fetchFollowingApprovedRedirects = async (
  initialUrl: string,
  allowedOrigins: readonly string[],
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
): Promise<Response | undefined> => {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (!approvedUrl(current, allowedOrigins)) return undefined;
    const response = await timedFetch(current, signal, host);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    current = new URL(location, current).href;
  }
  throw new Error("source_map_redirect_limit");
};

const timedFetch = async (
  url: string,
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
): Promise<Response> => {
  const timeout = AbortSignal.timeout(5_000);
  return await host.fetch(url, {
    method: "GET",
    headers: { Accept: "application/json, application/source-map+json;q=0.9" },
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
};

const boundedResponseText = async (
  response: Response,
  maximumBytes: number,
): Promise<{ readonly text: string; readonly bytes: number }> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new SourceMapByteLimitError(0);
  if (response.body === null) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new SourceMapByteLimitError(bytes);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes };
};

class SourceMapByteLimitError extends RangeError {
  constructor(readonly bytesRead: number) {
    super("source_map_bytes");
  }
}

const normalizeSourceMap = (
  request: WebSourceMapRequest,
  text: string,
  input: AnalyzeWebBundleInput,
): SourceMapItem => {
  const base = emptyItem(request);
  if (!validSourceMapEnvelope(text))
    return {
      ...base,
      status: "invalid",
      limitation: "Source-map JSON is not a bounded version 3 map.",
    };
  try {
    const map = new AnyMap(text, request.fetchUrl);
    if (map.sources.length > input.analysis_limits.max_original_sources)
      return {
        ...base,
        status: "truncated",
        limitation: "Source map exceeds the original-source inventory limit.",
      };
    const resolvedBySource = new Map<string, string>();
    const originalSources = map.sources.map((source, index) => {
      const content = map.sourcesContent?.[index];
      const resolved =
        map.resolvedSources[index] ?? source ?? "[unknown-source]";
      if (source !== null) resolvedBySource.set(source, resolved);
      return {
        source: sanitizeSource(resolved),
        artifact:
          typeof content === "string"
            ? createWebTextArtifact(content, sourceMediaType(source))
            : null,
      };
    });
    const mappings: SourceMapItem["mappings"] = [];
    let totalMappings = 0;
    eachMapping(map, (mapping) => {
      if (
        mapping.source === null ||
        mapping.originalLine === null ||
        mapping.originalColumn === null
      )
        return;
      totalMappings += 1;
      if (mappings.length >= input.analysis_limits.max_source_map_mappings)
        return;
      mappings.push({
        generated_line: mapping.generatedLine,
        generated_column: mapping.generatedColumn,
        source: sanitizeSource(
          resolvedBySource.get(mapping.source) ?? mapping.source,
        ),
        original_line: mapping.originalLine,
        original_column: mapping.originalColumn,
        name: mapping.name?.slice(0, 1_024) ?? null,
      });
    });
    const modules = originalModuleEdges(
      originalSources,
      input.analysis_limits.max_findings,
    );
    const mappingTruncated = totalMappings > mappings.length;
    const limitations = [
      ...(mappingTruncated
        ? [
            `Mappings were truncated from ${String(totalMappings)} to ${String(mappings.length)}.`,
          ]
        : []),
      ...(modules.truncated
        ? [
            `Original module edges were truncated to ${String(modules.edges.length)}.`,
          ]
        : []),
    ];
    return {
      ...base,
      status: mappingTruncated || modules.truncated ? "truncated" : "included",
      artifact: createWebTextArtifact(text, "application/source-map+json"),
      original_sources: originalSources,
      original_module_edges: modules.edges,
      mappings,
      limitation: limitations.length === 0 ? null : limitations.join(" "),
    };
  } catch {
    return {
      ...base,
      status: "invalid",
      limitation: "Source-map mappings could not be decoded safely.",
    };
  }
};

const originalModuleEdges = (
  sources: SourceMapItem["original_sources"],
  maximum: number,
): {
  readonly edges: SourceMapItem["original_module_edges"];
  readonly truncated: boolean;
} => {
  const edges: SourceMapItem["original_module_edges"] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.artifact === null) continue;
    for (const detector of originalImportDetectors) {
      for (const match of source.artifact.text.matchAll(detector.pattern)) {
        const specifier = match[1]?.slice(0, 4_096);
        if (specifier === undefined) continue;
        const key = `${source.source}\0${detector.kind}\0${specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (edges.length >= maximum) return { edges, truncated: true };
        edges.push({
          from_source: source.source,
          kind: detector.kind,
          specifier,
          resolved_source: resolveOriginalSource(specifier, source.source),
        });
      }
    }
  }
  return { edges, truncated: false };
};

const validSourceMapEnvelope = (text: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.version !== 3) return false;
  if (typeof parsed.mappings === "string")
    return Array.isArray(parsed.sources) && Array.isArray(parsed.names);
  if (!Array.isArray(parsed.sections) || parsed.sections.length > 10_000)
    return false;
  const pending: unknown[] = [...parsed.sections];
  let visited = 0;
  while (pending.length > 0) {
    const section = pending.pop();
    if (!isRecord(section) || !isRecord(section.offset) || !("map" in section))
      return false;
    visited += 1;
    if (visited > 10_000) return false;
    const map = section.map;
    if (!isRecord(map) || map.version !== 3) return false;
    if (Array.isArray(map.sections)) pending.push(...map.sections);
    else if (
      typeof map.mappings !== "string" ||
      !Array.isArray(map.sources) ||
      !Array.isArray(map.names)
    )
      return false;
  }
  return true;
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
  } catch {
    return false;
  }
};

const emptyItem = (request: WebSourceMapRequest): SourceMapItem => ({
  script_key: request.scriptKey,
  declared_url: request.declaredUrl,
  status: "fetch_failed",
  artifact: null,
  original_sources: [],
  original_module_edges: [],
  mappings: [],
  limitation: null,
});

const sanitizeSource = (value: string): string => {
  const bounded = value.slice(0, 4_096);
  try {
    const parsed = new URL(bounded);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? sanitizeBrowserUrl(parsed.href).url
      : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return bounded.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  }
};

const resolveOriginalSource = (
  specifier: string,
  base: string,
): string | null => {
  try {
    return sanitizeSource(new URL(specifier, base).href);
  } catch {
    return null;
  }
};

const sourceMediaType = (source: string | null): string =>
  source?.endsWith(".ts") || source?.endsWith(".tsx")
    ? "text/typescript"
    : "text/javascript";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLimitError = (value: unknown): value is RangeError =>
  value instanceof RangeError;

const originalImportDetectors = [
  {
    kind: "static_import" as const,
    pattern:
      /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"'\n]+)["']/gu,
  },
  {
    kind: "dynamic_import" as const,
    pattern: /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
  },
  {
    kind: "require" as const,
    pattern: /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
  },
] as const;
