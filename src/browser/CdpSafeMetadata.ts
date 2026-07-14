import type { WebPageInspection } from "../domain/browserObservation.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import {
  numberValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

type ResponseMetadata = WebPageInspection["metadata"]["responses"][number];
type LinkMetadata = ResponseMetadata["links"][number];
type AgentHint = WebPageInspection["metadata"]["agent_hints"][number];

/** Normalize an allowlisted subset of response metadata and discard raw headers. */
export const safeResponseMetadata = (
  requestId: string,
  url: string,
  response: UnknownRecord,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly response: ResponseMetadata;
  readonly agentHints: AgentHint[];
} => {
  const headers = normalizedHeaders(response.headers);
  const links = parseLinks(headers.get("link"), url, allowedOrigins);
  const csp = parseCsp(
    headers.get("content-security-policy"),
    url,
    allowedOrigins,
  );
  const agentHints = [
    ...links.flatMap((link) =>
      link.rel.some(isAgentRel)
        ? [agentHint("link_rel", link.rel.join(" "), link.href)]
        : [],
    ),
    ...agentHeaderNames.flatMap((name) =>
      headers.has(name) ? [agentHint("response_header", name, null)] : [],
    ),
    ...wellKnownHint(url),
  ];
  return {
    response: {
      request_id: requestId,
      url,
      mime_type: boundedHeader(stringValue(response.mimeType)),
      content_length: nonnegativeInteger(headers.get("content-length")),
      content_encoding: boundedHeader(headers.get("content-encoding")),
      csp,
      links,
      policies: {
        coop: policyToken(headers.get("cross-origin-opener-policy")),
        coep: policyToken(headers.get("cross-origin-embedder-policy")),
        corp: policyToken(headers.get("cross-origin-resource-policy")),
        referrer_policy: policyToken(headers.get("referrer-policy")),
        x_content_type_options: policyToken(
          headers.get("x-content-type-options"),
        ),
        permissions_policy_features: permissionFeatures(
          headers.get("permissions-policy"),
        ),
      },
    },
    agentHints,
  };
};

const normalizedHeaders = (value: unknown): ReadonlyMap<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return new Map();
  const headers = new Map<string, string>();
  for (const [name, raw] of Object.entries(value).slice(0, 500)) {
    const normalized = name.toLowerCase().slice(0, 256);
    const header =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(raw)
          : undefined;
    if (header !== undefined) headers.set(normalized, header.slice(0, 65_536));
  }
  return headers;
};

const parseCsp = (
  value: string | undefined,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): ResponseMetadata["csp"] => {
  const directives: ResponseMetadata["csp"]["directives"] = [];
  let nonceCount = 0;
  let hashCount = 0;
  for (const rawDirective of (value ?? "").split(";").slice(0, 100)) {
    const [rawName, ...tokens] = rawDirective.trim().split(/\s+/u);
    const name = (rawName ?? "").toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,99}$/u.test(name)) continue;
    const sources: ResponseMetadata["csp"]["directives"][number]["sources"] =
      [];
    for (const token of tokens.slice(0, 100)) {
      const lower = token.toLowerCase();
      if (lower.startsWith("'nonce-")) {
        nonceCount += 1;
        continue;
      }
      if (
        lower.startsWith("'sha256-") ||
        lower.startsWith("'sha384-") ||
        lower.startsWith("'sha512-")
      ) {
        hashCount += 1;
        continue;
      }
      sources.push(cspSource(token, baseUrl, allowedOrigins));
    }
    directives.push({ name, sources });
  }
  return { directives, nonce_count: nonceCount, hash_count: hashCount };
};

const cspSource = (
  token: string,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): ResponseMetadata["csp"]["directives"][number]["sources"][number] => {
  const lower = token.toLowerCase();
  if (/^'[a-z0-9-]+'$/u.test(lower))
    return { kind: "keyword", value: lower.slice(0, 100) };
  if (/^[a-z][a-z0-9+.-]*:$/u.test(lower))
    return { kind: "scheme", value: lower.slice(0, 100) };
  try {
    const parsed = new URL(token, baseUrl);
    return allowedOrigins.has(parsed.origin)
      ? { kind: "approved_origin", value: parsed.origin }
      : { kind: "external_origin", value: null };
  } catch {
    return { kind: "other", value: null };
  }
};

const parseLinks = (
  value: string | undefined,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): LinkMetadata[] => {
  const links: LinkMetadata[] = [];
  for (const entry of splitLinkHeader(value ?? "").slice(0, 100)) {
    const match = /^\s*<([^>]{1,4096})>(.*)$/u.exec(entry);
    if (match === null) continue;
    const parameters = linkParameters(match[2] ?? "");
    const destination = safeDestination(
      match[1] ?? "",
      baseUrl,
      allowedOrigins,
    );
    links.push({
      href: destination.url,
      destination_scope: destination.scope,
      rel: (parameters.get("rel") ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean)
        .slice(0, 32),
      as: boundedHeader(parameters.get("as")),
      type: boundedHeader(parameters.get("type")),
      crossorigin: boundedHeader(parameters.get("crossorigin")),
    });
  }
  return links;
};

const splitLinkHeader = (value: string): string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (character !== "," || quoted) continue;
    entries.push(value.slice(start, index));
    start = index + 1;
  }
  entries.push(value.slice(start));
  return entries;
};

const linkParameters = (value: string): ReadonlyMap<string, string> => {
  const parameters = new Map<string, string>();
  for (const raw of value.split(";").slice(1, 50)) {
    const separator = raw.indexOf("=");
    const name = (separator < 0 ? raw : raw.slice(0, separator))
      .trim()
      .toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,99}$/u.test(name)) continue;
    const parameter = separator < 0 ? "" : raw.slice(separator + 1).trim();
    parameters.set(name, unquote(parameter).slice(0, 1_024));
  }
  return parameters;
};

const safeDestination = (
  value: string,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: string | null;
  readonly scope: LinkMetadata["destination_scope"];
} => {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { url: null, scope: "unsupported" };
    if (!allowedOrigins.has(parsed.origin))
      return { url: null, scope: "outside_policy" };
    return { url: sanitizeBrowserUrl(parsed.href).url, scope: "approved" };
  } catch {
    return { url: null, scope: "unsupported" };
  }
};

const permissionFeatures = (value: string | undefined): string[] =>
  [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.split("=", 1)[0]?.trim().toLowerCase() ?? "")
        .filter((feature) => /^[a-z][a-z0-9-]{0,99}$/u.test(feature)),
    ),
  ]
    .sort()
    .slice(0, 200);

const wellKnownHint = (url: string): AgentHint[] => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return wellKnownAgentPaths.has(path)
      ? [agentHint("well_known_resource", path, sanitizeBrowserUrl(url).url)]
      : [];
  } catch {
    return [];
  }
};

const agentHint = (
  mechanism: AgentHint["mechanism"],
  declaration: string,
  url: string | null,
): AgentHint => ({
  mechanism,
  declaration: declaration.slice(0, 256),
  url,
  trust: "page-declared-untrusted",
});

const isAgentRel = (value: string): boolean =>
  ["mcp", "model-context", "ai-plugin", "service-desc"].includes(value);

const policyToken = (value: string | undefined): string | null => {
  const token = (value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,99}$/u.test(token) ? token : null;
};

const nonnegativeInteger = (value: string | undefined): number | null => {
  const number = numberValue(value === undefined ? undefined : Number(value));
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};

const boundedHeader = (value: string | undefined): string | null =>
  value === undefined ? null : value.trim().toLowerCase().slice(0, 256);

const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

const agentHeaderNames = ["x-model-context", "x-webmcp", "mcp-server"] as const;
const wellKnownAgentPaths: ReadonlySet<string> = new Set([
  "/.well-known/ai-plugin.json",
  "/.well-known/mcp",
  "/.well-known/model-context",
]);
