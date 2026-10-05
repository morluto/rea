import * as t from "@babel/types";
import { AnyMap, eachMapping } from "@jridgewell/trace-mapping";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { analyzeParsedJavaScriptSemantics } from "../domain/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../domain/javascriptSourceParser.js";
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
type ParsedSourceMapItem = Extract<
  SourceMapItem,
  { status: "included" | "partial" }
>;

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
  const retained = items.filter(
    ({ status }) => status === "included" || status === "partial",
  ).length;
  return webSourceMapsSchema.parse({
    status:
      items.length === 0
        ? "unavailable"
        : retained === items.length &&
            !items.some(({ status }) => status === "partial")
          ? "included"
          : retained > 0
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
    if (!response.ok) {
      await response.body?.cancel();
      return emptySourceMapItem(
        request,
        "fetch_failed",
        `Source-map server returned HTTP ${String(response.status)}.`,
      );
    }
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
    await response.body?.cancel();
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
      original_module_edges: modules.edges,
      mappings,
    };
    return modules.incomplete.length === 0
      ? { ...parsed, status: "included", limitation: null }
      : {
          ...parsed,
          status: "partial",
          limitation: `Module edges are incomplete: ${modules.incomplete.length} of ${originalSources.filter(({ artifact }) => artifact !== null).length} original sources could not be parsed in full (${modules.incomplete.join(", ")}).`,
        };
  } catch {
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map mappings could not be decoded safely.",
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
): OriginalModuleEdges => {
  const edges: ParsedSourceMapItem["original_module_edges"] = [];
  const seen = new Set<string>();
  const incomplete: string[] = [];
  for (const source of sources) {
    if (source.artifact === null) continue;
    const parsed = parseJavaScriptSource(source.artifact.text);
    if (parsed === null) {
      incomplete.push(source.source);
      continue;
    }
    // A recovered program still yields the imports it did parse, but nodes
    // after an unrecoverable point are missing, so the edges are a subset.
    if (parsed.errors.length > 0) incomplete.push(source.source);
    let unboundRequires: ReadonlySet<string> | undefined;
    t.traverseFast(parsed, (node) => {
      const dependency = originalDependency(node);
      if (dependency === null) return;
      const { kind, specifier } = dependency;
      if (kind === "require" && t.isCallExpression(node)) {
        unboundRequires ??= new Set(
          analyzeParsedJavaScriptSemantics(parsed)
            .references.filter(
              ({ name, role, resolution }) =>
                name === "require" &&
                role === "read" &&
                resolution === "unbound",
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
      edges.push({
        from_source: source.source,
        kind,
        specifier,
        resolved_source: resolveOriginalSource(specifier, source.source),
      });
    });
  }
  return { edges, incomplete };
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
