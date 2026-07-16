import { isAbsolute, relative, resolve, sep } from "node:path";

import { err, ok, type Result } from "./result.js";

/** Local capabilities governed by the shared REA permission policy. */
export type PermissionCapability =
  | "process_capture"
  | "browser_observe"
  | "electron_observe"
  | "evidence_read"
  | "evidence_write"
  | "investigation_input"
  | "investigation_workspace_read"
  | "investigation_workspace_write"
  | "snapshot_read"
  | "snapshot_write"
  | "artifact_extract"
  | "native_mount"
  | "reference_read"
  | "javascript_replay";

/** Ordered network authority; each mode includes the modes before it. */
type PermissionNetwork = "none" | "loopback" | "external";

/** Exact normalized scope requested by one local operation. */
export interface PermissionScope {
  readonly capability: PermissionCapability;
  readonly roots: readonly string[];
  readonly executables: readonly string[];
  readonly environment_names: readonly string[];
  readonly origins?: readonly string[] | undefined;
  readonly network: PermissionNetwork;
  readonly mount: boolean;
}

/** A request identity associates one-shot grants with exactly one operation. */
export interface PermissionRequest extends PermissionScope {
  readonly operation_identity: string;
}

/** Administrator-owned maximum authority for one capability. */
export type PermissionCeiling = PermissionScope;

/** Authority issued beneath the administrator ceiling. */
export interface PermissionGrant extends PermissionScope {
  readonly grant_id: string;
  readonly lifetime: "once" | "session" | "project" | "administrator";
  readonly operation_identity: string | null;
  readonly expires_at: string | null;
}

/** Missing requested authority, containing names and paths but never values. */
export interface MissingPermissionScope {
  readonly roots?: readonly string[];
  readonly executables?: readonly string[];
  readonly environment_names?: readonly string[];
  readonly origins?: readonly string[];
  readonly network?: PermissionNetwork;
  readonly mount?: true;
}

/** Immutable shared policy state. */
export interface PermissionPolicy {
  readonly ceilings: readonly PermissionCeiling[];
  readonly grants: readonly PermissionGrant[];
  readonly revoked_grant_ids: ReadonlySet<string>;
  readonly consumed_grant_ids: ReadonlySet<string>;
}

/** A proposed grant exceeds the administrator-owned maximum authority. */
export class PermissionGrantError extends Error {
  readonly _tag = "PermissionGrantError" as const;

  constructor(
    readonly reason: "outside_administrator_ceiling" | "invalid_once_scope",
    readonly missing: MissingPermissionScope,
  ) {
    super(`Permission grant rejected: ${reason}`);
  }
}

/** Observable decision returned before any governed side effect. */
export type PermissionDecision =
  | {
      readonly allowed: true;
      readonly grant_id: string;
      readonly lifetime: PermissionGrant["lifetime"];
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "outside_administrator_ceiling"
        | "grant_required"
        | "grant_revoked_or_consumed"
        | "grant_expired";
      readonly missing: MissingPermissionScope;
    };

/** Create a fail-closed policy with no implicit grants. */
export const createPermissionPolicy = (
  ceilings: readonly PermissionCeiling[],
  grants: readonly PermissionGrant[] = [],
): PermissionPolicy => ({
  ceilings: ceilings.map(normalizeScope),
  grants: grants.map(normalizeGrant),
  revoked_grant_ids: new Set(),
  consumed_grant_ids: new Set(),
});

/** Add one grant only when it is a subset of its administrator ceiling. */
export const grantPermission = (
  policy: PermissionPolicy,
  grant: PermissionGrant,
): Result<PermissionPolicy, PermissionGrantError> => {
  const normalized = normalizeGrant(grant);
  if (normalized.lifetime === "once" && normalized.operation_identity === null)
    return err(new PermissionGrantError("invalid_once_scope", {}));
  const missing = missingFromScopes(normalized, policy.ceilings);
  if (hasMissing(missing))
    return err(
      new PermissionGrantError("outside_administrator_ceiling", missing),
    );
  return ok({ ...policy, grants: [...policy.grants, normalized] });
};

/** Evaluate exact requested authority against the ceiling and active grants. */
export const evaluatePermission = (
  policy: PermissionPolicy,
  request: PermissionRequest,
  now: Date = new Date(),
): PermissionDecision => {
  const normalized = normalizeRequest(request);
  const outsideCeiling = missingFromScopes(normalized, policy.ceilings);
  if (hasMissing(outsideCeiling))
    return {
      allowed: false,
      reason: "outside_administrator_ceiling",
      missing: outsideCeiling,
    };
  const candidates = policy.grants.filter(
    (grant) =>
      grant.capability === normalized.capability &&
      !policy.revoked_grant_ids.has(grant.grant_id) &&
      !policy.consumed_grant_ids.has(grant.grant_id) &&
      !isExpired(grant, now) &&
      (grant.lifetime !== "once" ||
        grant.operation_identity === normalized.operation_identity),
  );
  const selected = candidates.find(
    (grant) => !hasMissing(missingFromScopes(normalized, [grant])),
  );
  if (selected !== undefined)
    return {
      allowed: true,
      grant_id: selected.grant_id,
      lifetime: selected.lifetime,
    };
  const coveringGrant = policy.grants.find(
    (grant) =>
      grant.capability === normalized.capability &&
      (grant.lifetime !== "once" ||
        grant.operation_identity === normalized.operation_identity) &&
      !hasMissing(missingFromScopes(normalized, [grant])),
  );
  return {
    allowed: false,
    reason:
      coveringGrant !== undefined && isExpired(coveringGrant, now)
        ? "grant_expired"
        : coveringGrant !== undefined
          ? "grant_revoked_or_consumed"
          : "grant_required",
    missing: missingFromScopes(normalized, candidates),
  };
};

/** Consume an allowed one-shot decision; longer-lived grants are unchanged. */
export const consumePermission = (
  policy: PermissionPolicy,
  decision: Extract<PermissionDecision, { readonly allowed: true }>,
): PermissionPolicy =>
  decision.lifetime === "once"
    ? {
        ...policy,
        consumed_grant_ids: new Set([
          ...policy.consumed_grant_ids,
          decision.grant_id,
        ]),
      }
    : policy;

/** Revoke one grant for every future evaluation. */
export const revokePermission = (
  policy: PermissionPolicy,
  grantId: string,
): PermissionPolicy => ({
  ...policy,
  revoked_grant_ids: new Set([...policy.revoked_grant_ids, grantId]),
});

/** Drop connection-bound authority when an MCP or CLI session ends. */
export const clearSessionPermissions = (
  policy: PermissionPolicy,
): PermissionPolicy => ({
  ...policy,
  grants: policy.grants.filter(
    ({ lifetime }) => lifetime !== "once" && lifetime !== "session",
  ),
});

/** Atomically replace administrator ceilings while retaining auditable grants. */
export const reloadPermissionCeilings = (
  policy: PermissionPolicy,
  ceilings: readonly PermissionCeiling[],
): PermissionPolicy => ({
  ...policy,
  ceilings: ceilings.map(normalizeScope),
});

const normalizeScope = (scope: PermissionScope): PermissionScope => ({
  capability: scope.capability,
  roots: uniqueSorted(scope.roots.map((path) => resolve(path))),
  executables: uniqueSorted(scope.executables.map((path) => resolve(path))),
  environment_names: uniqueSorted(scope.environment_names),
  ...(scope.origins === undefined
    ? {}
    : { origins: uniqueSorted(scope.origins) }),
  network: scope.network,
  mount: scope.mount,
});

const normalizeGrant = (grant: PermissionGrant): PermissionGrant => ({
  ...normalizeScope(grant),
  grant_id: grant.grant_id,
  lifetime: grant.lifetime,
  operation_identity: grant.operation_identity,
  expires_at: grant.expires_at,
});

const normalizeRequest = (request: PermissionRequest): PermissionRequest => ({
  ...normalizeScope(request),
  operation_identity: request.operation_identity,
});

const missingFromScopes = (
  request: PermissionScope,
  scopes: readonly PermissionScope[],
): MissingPermissionScope => {
  const relevant = scopes.filter(
    ({ capability }) => capability === request.capability,
  );
  const roots = request.roots.filter(
    (path) => !relevant.some((scope) => containsAny(scope.roots, path)),
  );
  const executables = request.executables.filter(
    (path) => !relevant.some((scope) => containsAny(scope.executables, path)),
  );
  const environmentNames = request.environment_names.filter(
    (name) => !relevant.some((scope) => scope.environment_names.includes(name)),
  );
  const origins = (request.origins ?? []).filter(
    (origin) =>
      !relevant.some((scope) => (scope.origins ?? []).includes(origin)),
  );
  const network =
    request.network === "none" ||
    relevant.some(
      (scope) => networkRank(scope.network) >= networkRank(request.network),
    )
      ? undefined
      : request.network;
  const mount =
    !request.mount || relevant.some((scope) => scope.mount)
      ? undefined
      : (true as const);
  return {
    ...(roots.length === 0 ? {} : { roots }),
    ...(executables.length === 0 ? {} : { executables }),
    ...(environmentNames.length === 0
      ? {}
      : { environment_names: environmentNames }),
    ...(origins.length === 0 ? {} : { origins }),
    ...(network === undefined ? {} : { network }),
    ...(mount === undefined ? {} : { mount }),
  };
};

interface PathOperations {
  readonly relative: typeof relative;
  readonly isAbsolute: typeof isAbsolute;
  readonly sep: string;
}

const HOST_PATH_OPERATIONS: PathOperations = { relative, isAbsolute, sep };

/** Test whether a candidate is inside a root using one platform path flavor. */
export const isPathContained = (
  root: string,
  candidate: string,
  operations: PathOperations = HOST_PATH_OPERATIONS,
): boolean => {
  const relation = operations.relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${operations.sep}`) &&
      !operations.isAbsolute(relation))
  );
};

const containsAny = (roots: readonly string[], candidate: string): boolean =>
  roots.some((root) => isPathContained(root, candidate));

const networkRank = (network: PermissionNetwork): number => {
  switch (network) {
    case "none":
      return 0;
    case "loopback":
      return 1;
    case "external":
      return 2;
  }
};

const isExpired = (grant: PermissionGrant, now: Date): boolean =>
  grant.expires_at !== null && Date.parse(grant.expires_at) <= now.getTime();

const hasMissing = (missing: MissingPermissionScope): boolean =>
  Object.keys(missing).length > 0;

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));
