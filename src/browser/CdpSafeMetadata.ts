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
        referrer_policy: referrerPolicy(headers.get("referrer-policy")),
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
  for (const [name, raw] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    const header =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(raw)
          : undefined;
    if (header !== undefined) headers.set(normalized, header);
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
  for (const rawDirective of (value ?? "").split(";")) {
    const [rawName, ...tokens] = rawDirective.trim().split(/\s+/u);
    const name = (rawName ?? "").toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) continue;
    const sources: ResponseMetadata["csp"]["directives"][number]["sources"] =
      [];
    for (const token of tokens) {
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
  if (/^'[a-z0-9-]+'$/u.test(lower)) return { kind: "keyword", value: lower };
  if (/^[a-z][a-z0-9+.-]*:$/u.test(lower))
    return { kind: "scheme", value: lower };
  const hostOrigin = cspHostSourceOrigin(token, baseUrl);
  if (hostOrigin === undefined) return { kind: "other", value: null };
  return hostOrigin !== null && allowedOrigins.has(hostOrigin)
    ? { kind: "approved_origin", value: hostOrigin }
    : { kind: "external_origin", value: null };
};

/**
 * Resolve a CSP host-source (CSP3 §2.3.1) to the single origin it names. A
 * scheme-less source inherits the protected resource's scheme instead of being
 * resolved as a page-relative path. Returns `null` for a recognized wildcard
 * host or port, which denotes a set of origins rather than one origin, and
 * `undefined` when the token is not a host-source at all.
 */
const cspHostSourceOrigin = (
  token: string,
  baseUrl: string,
): string | null | undefined => {
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)(?:\/[^?#]*)?$/iu.exec(
    token,
  );
  const authority = match?.[2];
  if (authority === undefined || authority.length === 0) return undefined;
  const scheme = (match?.[1] ?? schemeOf(baseUrl))?.toLowerCase();
  if (scheme === undefined || !/^[a-z][a-z0-9+.-]*$/u.test(scheme))
    return undefined;
  if (
    !/^(?:\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(?::(?:\*|\d+))?$/iu.test(
      authority,
    )
  )
    return undefined;
  if (authority.includes("*")) return null;
  try {
    const parsed = new URL(`${scheme}://${authority}`);
    return parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.origin !== "null"
      ? parsed.origin
      : undefined;
  } catch (cause: unknown) {
    // Authorities that are not a bare host[:port] are classified as other.
    void cause;
    return undefined;
  }
};

const schemeOf = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).protocol.replace(/:$/u, "");
  } catch (cause: unknown) {
    // An unparseable protected-resource URL cannot lend a scheme.
    void cause;
    return undefined;
  }
};

const parseLinks = (
  value: string | undefined,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): LinkMetadata[] => {
  const links: LinkMetadata[] = [];
  for (const entry of splitLinkHeader(value ?? "")) {
    const match = /^\s*<([^>]*)>(.*)$/u.exec(entry);
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
        .filter(Boolean),
      as: boundedHeader(parameters.get("as")),
      type: boundedHeader(parameters.get("type")),
      crossorigin: boundedHeader(parameters.get("crossorigin")),
    });
  }
  return links;
};

const splitLinkHeader = (
  value: string,
  delimiter: "," | ";" = ",",
): string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let target = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"' && !target) quoted = true;
    else if (delimiter === "," && character === "<") target = true;
    else if (delimiter === "," && character === ">") target = false;
    else if (character === delimiter && !target) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
};

const linkParameters = (value: string): ReadonlyMap<string, string> => {
  const parameters = new Map<string, string>();
  for (const raw of splitLinkHeader(value, ";").slice(1)) {
    const separator = raw.indexOf("=");
    const name = (separator < 0 ? raw : raw.slice(0, separator))
      .trim()
      .toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) continue;
    const parameter = separator < 0 ? "" : raw.slice(separator + 1).trim();
    parameters.set(name, unquote(parameter));
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
    const sanitized = sanitizeBrowserUrl(parsed.href).url;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { url: sanitized, scope: "unsupported" };
    if (!allowedOrigins.has(parsed.origin))
      return { url: sanitized, scope: "outside_policy" };
    return { url: sanitized, scope: "approved" };
  } catch (cause: unknown) {
    // Unparseable link values keep their raw text for the analyst.
    void cause;
    return { url: value, scope: "unsupported" };
  }
};

const permissionFeatures = (value: string | undefined): string[] =>
  [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.split("=", 1)[0]?.trim().toLowerCase() ?? "")
        .filter((feature) => /^[a-z][a-z0-9-]*$/u.test(feature)),
    ),
  ].sort();

const wellKnownHint = (url: string): AgentHint[] => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return wellKnownAgentPaths.has(path)
      ? [agentHint("well_known_resource", path, sanitizeBrowserUrl(url).url)]
      : [];
  } catch (cause: unknown) {
    // Non-URL input yields no well-known hint.
    void cause;
    return [];
  }
};

const agentHint = (
  mechanism: AgentHint["mechanism"],
  declaration: string,
  url: string | null,
): AgentHint => ({
  mechanism,
  declaration,
  url,
  trust: "page-declared-untrusted",
});

const isAgentRel = (value: string): boolean =>
  ["mcp", "model-context", "ai-plugin", "service-desc"].includes(value);

const referrerPolicies = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);

const referrerPolicy = (value: string | undefined): string | null => {
  let policy: string | null = null;
  for (const raw of (value ?? "").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!/^[a-z-]*$/u.test(token)) return null;
    if (referrerPolicies.has(token)) policy = token;
  }
  return policy;
};

const policyToken = (value: string | undefined): string | null => {
  const token = (value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]*$/u.test(token) ? token : null;
};

const nonnegativeInteger = (value: string | undefined): number | null => {
  const number = numberValue(value === undefined ? undefined : Number(value));
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};

const boundedHeader = (value: string | undefined): string | null =>
  value === undefined ? null : value.trim().toLowerCase();

const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

const agentHeaderNames = ["x-model-context", "x-webmcp", "mcp-server"] as const;
const wellKnownAgentPaths: ReadonlySet<string> = new Set([
  "/.well-known/ai-plugin.json",
  "/.well-known/mcp",
  "/.well-known/model-context",
]);
