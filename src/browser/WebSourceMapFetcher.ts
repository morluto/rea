import { AnyMap, eachMapping } from "@jridgewell/trace-mapping";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { hasValidSourceMapContents } from "../domain/sourceMapContents.js";
import type {
  AnalyzeWebBundleInput,
  WebSourceMapItem,
  WebSourceMaps,
} from "../domain/webBundleAnalysis.js";
import { webSourceMapsSchema } from "../domain/webBundleAnalysis.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";

export interface WebSourceMapRequest {
  readonly scriptKey: string;
  readonly declaredUrl: string;
  readonly fetchUrl: string;
}

interface SourceMapFetchHost {
  readonly fetch: typeof fetch;
}

type SourceMaps = WebSourceMaps;
type SourceMapItem = WebSourceMapItem;
type ParsedSourceMapItem = Extract<SourceMapItem, { status: "included" }>;

/** Fetch and validate approved source maps without browser credentials. */
export const fetchWebSourceMaps = async (
  requests: readonly WebSourceMapRequest[],
  input: AnalyzeWebBundleInput,
  signal?: AbortSignal,
  host: SourceMapFetchHost = { fetch: globalThis.fetch },
): Promise<SourceMaps> => {
  const items: SourceMapItem[] = [];
  for (const request of requests) {
    if (signal?.aborted === true) throw signal.reason;
    items.push(await fetchOne(request, input, signal, host));
  }
  const included = items.filter(({ status }) => status === "included").length;
  return webSourceMapsSchema.parse({
    status:
      items.length === 0
        ? "unavailable"
        : included === items.length
          ? "included"
          : included > 0
            ? "partial"
            : "unavailable",
    requested: requests.length,
    processed: items.length,
    items,
  });
};

const fetchOne = async (
  request: WebSourceMapRequest,
  input: AnalyzeWebBundleInput,
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
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
    const { response, fetchedUrl } = fetched;
    if (!response.ok)
      return emptySourceMapItem(
        request,
        "fetch_failed",
        `Source-map server returned HTTP ${String(response.status)}.`,
      );
    return normalizeSourceMap(request, await response.text(), fetchedUrl);
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    return emptySourceMapItem(
      request,
      "fetch_failed",
      "Source-map fetch or validation failed.",
    );
  }
};

const fetchFollowingApprovedRedirects = async (
  initialUrl: string,
  allowedOrigins: readonly string[],
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
): Promise<{ response: Response; fetchedUrl: string } | undefined> => {
  let current = initialUrl;
  const visited = new Set<string>();
  for (;;) {
    if (!approvedUrl(current, allowedOrigins)) return undefined;
    if (visited.has(current)) throw new Error("source_map_redirect_loop");
    visited.add(current);
    const response = await host.fetch(current, {
      method: "GET",
      headers: {
        Accept: "application/json, application/source-map+json;q=0.9",
      },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status < 300 || response.status >= 400)
      return { response, fetchedUrl: current };
    const location = response.headers.get("location");
    if (location === null) return { response, fetchedUrl: current };
    current = new URL(location, current).href;
  }
};

const normalizeSourceMap = (
  request: WebSourceMapRequest,
  text: string,
  fetchedUrl: string,
): SourceMapItem => {
  if (!validSourceMapEnvelope(text))
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map JSON is not a version 3 map.",
    );
  try {
    const map = new AnyMap(text, fetchedUrl);
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
    const mappings: ParsedSourceMapItem["mappings"] = [];
    eachMapping(map, (mapping) => {
      if (
        mapping.source === null ||
        mapping.originalLine === null ||
        mapping.originalColumn === null
      )
        return;
      mappings.push({
        generated_line: mapping.generatedLine,
        generated_column: mapping.generatedColumn,
        source: sanitizeSource(
          resolvedBySource.get(mapping.source) ?? mapping.source,
        ),
        original_line: mapping.originalLine,
        original_column: mapping.originalColumn,
        name: mapping.name ?? null,
      });
    });
    const modules = originalModuleEdges(originalSources);
    const parsed = {
      ...sourceMapContext(request),
      artifact: createWebTextArtifact(text, "application/source-map+json"),
      original_sources: originalSources,
      original_module_edges: modules,
      mappings,
    };
    return { ...parsed, status: "included", limitation: null };
  } catch {
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map mappings could not be decoded safely.",
    );
  }
};

const originalModuleEdges = (
  sources: ParsedSourceMapItem["original_sources"],
): ParsedSourceMapItem["original_module_edges"] => {
  const edges: ParsedSourceMapItem["original_module_edges"] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.artifact === null) continue;
    for (const detector of originalImportDetectors) {
      for (const match of source.artifact.text.matchAll(detector.pattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const key = `${source.source}\0${detector.kind}\0${specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          from_source: source.source,
          kind: detector.kind,
          specifier,
          resolved_source: resolveOriginalSource(specifier, source.source),
        });
      }
    }
  }
  return edges;
};

const validSourceMapEnvelope = (text: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.version !== 3) return false;
  if (typeof parsed.mappings === "string") return validSourceMapLeaf(parsed);
  if (!Array.isArray(parsed.sections)) return false;
  const pending: unknown[] = [...parsed.sections];
  while (pending.length > 0) {
    const section = pending.pop();
    if (!isRecord(section) || !isRecord(section.offset) || !("map" in section))
      return false;
    const map = section.map;
    if (!isRecord(map) || map.version !== 3) return false;
    if (Array.isArray(map.sections))
      for (const child of map.sections) pending.push(child);
    else if (!validSourceMapLeaf(map)) return false;
  }
  return true;
};

const validSourceMapLeaf = (map: Readonly<Record<string, unknown>>): boolean =>
  typeof map.mappings === "string" &&
  Array.isArray(map.sources) &&
  Array.isArray(map.names) &&
  hasValidSourceMapContents(map.sources.length, map.sourcesContent);

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
  } catch {
    return value;
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
