import { selectCdpDiscoveryTarget } from "./CdpDiscoveryTargets.js";
import { cdpOriginScopeRefusal } from "./CdpOriginScopeError.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import type { BrowserTargetList } from "../domain/browserObservationSchemas.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";

/** Why a target is outside the HTTP(S) page scope, named as target listing counts it. */
type CdpTargetExclusion = keyof BrowserTargetList["excluded"];

/** Classify a target's type and origin once for target listing and selection. */
export const classifyCdpTarget = (
  target: Pick<CdpEndpointTarget, "type" | "url">,
  allowedOrigins: ReadonlySet<string> | undefined,
):
  | { readonly excluded: CdpTargetExclusion }
  | {
      readonly excluded?: undefined;
      readonly url: string;
      readonly origin: string;
    } => {
  if (target.type !== "page") return { excluded: "non_page" };
  const { url, origin } = sanitizeBrowserUrl(target.url);
  if (origin === null) return { excluded: "unsupported_url" };
  if (allowedOrigins !== undefined && !allowedOrigins.has(origin))
    return { excluded: "disallowed_origin" };
  return { url, origin };
};

/** Select one page target and derive its origin scope before opening a CDP session. */
export const authorizeCdpTarget = (
  discovery: CdpEndpointDiscovery,
  input: {
    readonly target_id: string;
    readonly allowed_origins: readonly string[];
  },
  operation: BrowserObservationOperation,
): {
  readonly target: CdpEndpointTarget;
  readonly allowedOrigins: ReadonlySet<string>;
} => {
  const target = selectCdpDiscoveryTarget(
    discovery.targets,
    input.target_id,
    operation,
    discovery.ambiguousTargetIds,
  );
  if (target === undefined)
    throw new BrowserObservationError(operation, "target_not_found", {
      detail: `Target ${input.target_id} was not found at the selected endpoint.`,
      remediationAction:
        "Refresh target discovery for that endpoint and retry with a returned target ID.",
    });
  const requested =
    input.allowed_origins.length > 0
      ? new Set(input.allowed_origins)
      : undefined;
  const scope = classifyCdpTarget(target, requested);
  if (scope.excluded !== undefined)
    throw targetScopeRefusal(operation, input.target_id, scope.excluded);
  return { target, allowedOrigins: requested ?? new Set([scope.origin]) };
};

/**
 * Each exclusion has its own repair. The refusal names the exclusion but
 * withholds the target's URL, title and origin, as target listing does.
 */
const targetScopeRefusal = (
  operation: BrowserObservationOperation,
  targetId: string,
  exclusion: CdpTargetExclusion,
): BrowserObservationError => {
  if (exclusion === "disallowed_origin")
    return cdpOriginScopeRefusal(operation, {
      detail: `Target ${targetId} is a page outside the selected allowed_origins.`,
    });
  if (exclusion === "unsupported_url")
    return new BrowserObservationError(operation, "target_not_allowed", {
      detail: `Target ${targetId} is a page without an HTTP(S) origin.`,
      remediationAction:
        "allowed_origins accepts only HTTP(S) origins and cannot admit this page. Select an HTTP(S) page target from list_browser_targets for the same endpoint and retry with its target ID. For a local file:// page, such as an Electron renderer, list_electron_targets and inspect_electron_page provide a separate passive inspection.",
    });
  return new BrowserObservationError(operation, "target_not_allowed", {
    detail: `Target ${targetId} is not a page target.`,
    remediationAction:
      "Select a page target from list_browser_targets for the same endpoint and retry with its target ID.",
  });
};
