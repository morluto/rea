import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

export interface WebInventoryResourceInput {
  readonly url: string;
  readonly origin: string | null;
  readonly type: string;
  readonly mime_type: string;
  readonly content_size: number | null;
}

export interface WebInventoryScriptInput {
  readonly url: string;
  readonly cdp_hash: string;
  readonly length: number;
  readonly is_module: boolean;
  readonly language: string | null;
  readonly source_map_url: string | null;
}

export interface StableWebResource extends WebInventoryResourceInput {
  readonly resource_key: string;
}

export type WebResourceReconciliation =
  | { readonly status: "exact"; readonly resource_key: string }
  | { readonly status: "ambiguous"; readonly candidate_resource_keys: string[] }
  | { readonly status: "unmatched"; readonly reason: "no_exact_sanitized_url" };

/** Assign deterministic identities to a bounded resource inventory. */
export const stableWebResources = (
  resources: readonly WebInventoryResourceInput[],
): StableWebResource[] => {
  const keyed = resources.map((resource) => ({
    ...resource,
    resource_key: `res_${digest(resource)}`,
  }));
  return [
    ...new Map(
      keyed.map((resource) => [resource.resource_key, resource]),
    ).values(),
  ].sort(
    (left, right) =>
      left.resource_key.localeCompare(right.resource_key) ||
      left.url.localeCompare(right.url),
  );
};

/** Reconcile one script with resource-tree observations without fuzzy matching. */
export const reconcileWebScript = (
  script: WebInventoryScriptInput,
  resources: readonly StableWebResource[],
): WebResourceReconciliation => {
  const candidates = resources.filter(
    (resource) => resource.url === script.url,
  );
  if (candidates.length === 1)
    return { status: "exact", resource_key: candidates[0]?.resource_key ?? "" };
  if (candidates.length > 1)
    return {
      status: "ambiguous",
      candidate_resource_keys: uniqueResourceKeys(candidates),
    };
  return { status: "unmatched", reason: "no_exact_sanitized_url" };
};

/** Prefer exact transient raw-URL matching, then report sanitized ambiguity. */
export const reconcileCapturedWebScript = (
  script: WebInventoryScriptInput & { readonly rawUrl: string },
  rawResources: readonly (WebInventoryResourceInput & {
    readonly rawUrl: string;
  })[],
  resources: readonly StableWebResource[],
): WebResourceReconciliation => {
  const exact = rawResources.filter(
    (resource) => resource.rawUrl === script.rawUrl,
  );
  if (exact.length === 1) {
    const resource = exact[0];
    if (resource !== undefined) {
      const { rawUrl: _rawUrl, ...publicResource } = resource;
      const stable = stableWebResources([publicResource])[0];
      if (stable !== undefined)
        return { status: "exact", resource_key: stable.resource_key };
    }
  }
  const candidates = resources.filter(
    (resource) => resource.url === script.url,
  );
  if (candidates.length > 0)
    return {
      status: "ambiguous",
      candidate_resource_keys: uniqueResourceKeys(candidates),
    };
  return { status: "unmatched", reason: "no_exact_sanitized_url" };
};

/** Stable script identity excludes target IDs, CDP script IDs, and timestamps. */
export const stableWebScriptKey = (script: WebInventoryScriptInput): string =>
  `scr_${digest({
    url: script.url,
    cdp_hash: script.cdp_hash,
    length: script.length,
    is_module: script.is_module,
    language: script.language,
    source_map_url: script.source_map_url,
  })}`;

const uniqueResourceKeys = (
  resources: readonly StableWebResource[],
): string[] =>
  [...new Set(resources.map(({ resource_key }) => resource_key))].sort();

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Web inventory value is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
