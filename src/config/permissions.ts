import { isLiteralLoopbackHostname } from "../domain/browserObservation.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "../domain/permissionPolicy.js";

export const filePolicy = (roots: readonly string[]): EvidenceFilePolicy => ({
  roots,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

export const permissionScope = (
  capability: PermissionCeiling["capability"],
  roots: readonly string[],
  options: Partial<Omit<PermissionCeiling, "capability" | "roots">> = {},
): PermissionCeiling => ({
  capability,
  roots,
  executables: options.executables ?? [],
  environment_names: options.environment_names ?? [],
  ...(options.origins === undefined ? {} : { origins: options.origins }),
  network: options.network ?? "none",
  mount: options.mount ?? false,
});

export const administratorGrants = (
  ceilings: readonly PermissionCeiling[],
): readonly PermissionGrant[] =>
  ceilings.map((ceiling) => ({
    ...ceiling,
    grant_id: `administrator:${ceiling.capability}`,
    lifetime: "administrator",
    operation_identity: null,
    expires_at: null,
  }));

export const browserNetworkScope = (
  origins: readonly string[],
): "loopback" | "external" =>
  origins.every((origin) => {
    const hostname = new URL(origin).hostname;
    return isLiteralLoopbackHostname(hostname);
  })
    ? "loopback"
    : "external";
