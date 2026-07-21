import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  PermissionCeiling,
  PermissionDecision,
  PermissionGrant,
  PermissionPolicy,
  PermissionRequest,
  PermissionScope,
} from "../domain/permissionPolicy.js";
import {
  consumePermission,
  clearSessionPermissions,
  createPermissionPolicy,
  evaluatePermission,
  grantPermission,
  reloadPermissionCeilings,
  revokePermission,
} from "../domain/permissionPolicy.js";
import { PermissionRequiredError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Failure to establish a filesystem object's canonical authorization identity. */
export class PermissionPathError extends Error {
  readonly _tag = "PermissionPathError" as const;

  constructor(
    readonly path: string,
    readonly reason: "not_found" | "io",
    options?: ErrorOptions,
  ) {
    super(`Cannot canonicalize permission path: ${path}`, options);
  }
}

/** Canonicalize administrator ceilings before they become authorization state. */
export const canonicalizePermissionCeilings = async (
  ceilings: readonly PermissionCeiling[],
): Promise<Result<readonly PermissionCeiling[], PermissionPathError>> => {
  const normalized: PermissionCeiling[] = [];
  for (const ceiling of ceilings) {
    const canonical = await canonicalizeScope(ceiling, "read");
    if (!canonical.ok) return canonical;
    normalized.push(canonical.value);
  }
  return ok(normalized);
};

/** Canonicalize one exact operation request before subset evaluation. */
export const canonicalizePermissionRequest = async (
  request: PermissionRequest,
  access: "read" | "write",
): Promise<Result<PermissionRequest, PermissionPathError>> => {
  const canonical = await canonicalizeScope(request, access);
  return canonical.ok
    ? ok({ ...canonical.value, operation_identity: request.operation_identity })
    : canonical;
};

const canonicalizeScope = async (
  scope: PermissionScope,
  access: "read" | "write",
): Promise<Result<PermissionScope, PermissionPathError>> => {
  const roots = await canonicalizePaths(scope.roots, access);
  if (!roots.ok) return roots;
  const executables = await canonicalizePaths(scope.executables, "read");
  if (!executables.ok) return executables;
  return ok({ ...scope, roots: roots.value, executables: executables.value });
};

const canonicalizePaths = async (
  paths: readonly string[],
  access: "read" | "write",
): Promise<Result<readonly string[], PermissionPathError>> => {
  const canonical: string[] = [];
  for (const path of paths) {
    const result = await canonicalizePath(path, access);
    if (!result.ok) return result;
    canonical.push(result.value);
  }
  return ok(canonical);
};

const canonicalizePath = async (
  path: string,
  access: "read" | "write",
): Promise<Result<string, PermissionPathError>> => {
  const requested = resolve(path);
  try {
    return ok(await realpath(requested));
  } catch (cause: unknown) {
    if (access !== "write" || !isNotFound(cause))
      return err(new PermissionPathError(path, errorReason(cause), { cause }));
  }
  try {
    const parent = await realpath(dirname(requested));
    return ok(join(parent, basename(requested)));
  } catch (cause: unknown) {
    return err(new PermissionPathError(path, errorReason(cause), { cause }));
  }
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const errorReason = (error: unknown): PermissionPathError["reason"] =>
  isNotFound(error) ? "not_found" : "io";

interface PermissionEvaluationOptions {
  readonly elicitationSupported?: boolean;
  readonly restartRequired?: boolean;
}

interface CanonicalPermissionDecision {
  readonly decision: Extract<PermissionDecision, { readonly allowed: true }>;
  readonly owner: PermissionAuthority;
  readonly request: PermissionRequest;
}

type AuthorizedPermission = PermissionDecision & {
  readonly allowed: true;
  readonly request: PermissionRequest;
};

type PermissionAuthorizationResult = Promise<
  Result<AuthorizedPermission, PermissionPathError | PermissionRequiredError>
>;

/** Stateful owner for permission evaluation, consumption, reload, and revoke. */
export class PermissionAuthority {
  private policy: PermissionPolicy;
  private readonly configuredAuthority: PermissionAuthority | undefined;
  private readonly outsideCeilingRestartRequired: boolean;

  constructor(
    policy: PermissionPolicy,
    configuredAuthority?: PermissionAuthority,
    outsideCeilingRestartRequired = false,
  ) {
    this.policy = policy;
    this.configuredAuthority = configuredAuthority;
    this.outsideCeilingRestartRequired = outsideCeilingRestartRequired;
  }

  /** Create a connection-owned overlay for once and session grants. */
  createConnectionAuthority(): PermissionAuthority {
    return new PermissionAuthority(
      createPermissionPolicy([]),
      this.configuredAuthority ?? this,
      true,
    );
  }

  /** Canonicalize and authorize one exact operation before its side effect. */
  async authorize(
    request: PermissionRequest,
    access: "read" | "write",
    options: PermissionEvaluationOptions = {},
  ): PermissionAuthorizationResult {
    const evaluated = await this.evaluateRequest(request, access, options);
    if (!evaluated.ok) return evaluated;
    const { decision, owner, request: canonicalRequest } = evaluated.value;
    owner.policy = consumePermission(owner.policy, decision);
    return ok({ ...decision, request: canonicalRequest });
  }

  /** Dry-run the exact shared evaluation without consuming a once grant. */
  async explain(
    request: PermissionRequest,
    access: "read" | "write",
    options: PermissionEvaluationOptions = {},
  ): PermissionAuthorizationResult {
    const evaluated = await this.evaluateRequest(request, access, options);
    return evaluated.ok
      ? ok({
          ...evaluated.value.decision,
          request: evaluated.value.request,
        })
      : evaluated;
  }

  private async evaluateRequest(
    request: PermissionRequest,
    access: "read" | "write",
    options: PermissionEvaluationOptions,
  ): Promise<
    Result<
      CanonicalPermissionDecision,
      PermissionPathError | PermissionRequiredError
    >
  > {
    const canonical = await canonicalizePermissionRequest(request, access);
    if (!canonical.ok) return canonical;
    const evaluated = this.evaluateCanonical(canonical.value, options);
    return evaluated.ok
      ? ok({ ...evaluated.value, request: canonical.value })
      : evaluated;
  }

  /** Add authority beneath the administrator ceiling. */
  grant(grant: PermissionGrant): ReturnType<typeof grantPermission> {
    const policy =
      this.configuredAuthority === undefined
        ? this.policy
        : {
            ...this.policy,
            ceilings: this.configuredAuthority.effectivePolicy().ceilings,
          };
    const result = grantPermission(policy, grant);
    if (result.ok) this.policy = result.value;
    return result;
  }

  /** Revoke authority immediately for subsequent operations. */
  revoke(grantId: string): void {
    this.policy = revokePermission(this.policy, grantId);
  }

  /** Drop once/session authority when its owning connection ends. */
  clearSessionGrants(): void {
    this.policy = clearSessionPermissions(this.policy);
  }

  private effectivePolicy(): PermissionPolicy {
    if (this.configuredAuthority === undefined) return this.policy;
    const configured = this.configuredAuthority.effectivePolicy();
    return {
      ceilings: configured.ceilings,
      grants: [...configured.grants, ...this.policy.grants],
      revoked_grant_ids: new Set([
        ...configured.revoked_grant_ids,
        ...this.policy.revoked_grant_ids,
      ]),
      consumed_grant_ids: new Set([
        ...configured.consumed_grant_ids,
        ...this.policy.consumed_grant_ids,
      ]),
    };
  }

  private evaluateCanonical(
    request: PermissionRequest,
    options: PermissionEvaluationOptions,
  ): Result<
    {
      readonly decision: Extract<
        PermissionDecision,
        { readonly allowed: true }
      >;
      readonly owner: PermissionAuthority;
    },
    PermissionRequiredError
  > {
    const configured = this.configuredAuthority;
    if (configured !== undefined) {
      const configuredDecision = evaluatePermission(
        configured.effectivePolicy(),
        request,
      );
      if (configuredDecision.allowed)
        return ok({ decision: configuredDecision, owner: configured });
    }
    const localPolicy =
      configured === undefined
        ? this.policy
        : { ...this.policy, ceilings: configured.effectivePolicy().ceilings };
    const localDecision = evaluatePermission(localPolicy, request);
    if (localDecision.allowed)
      return ok({ decision: localDecision, owner: this });
    const effective = this.effectivePolicy();
    const denied = evaluatePermission(effective, request);
    if (denied.allowed) return ok({ decision: denied, owner: this });
    const outsideAdministratorCeiling =
      denied.reason === "outside_administrator_ceiling";
    return err(
      new PermissionRequiredError(
        request,
        denied.missing,
        ceilingFor(effective, request.capability),
        !outsideAdministratorCeiling && (options.elicitationSupported ?? false),
        options.restartRequired ??
          (outsideAdministratorCeiling && this.outsideCeilingRestartRequired),
      ),
    );
  }

  /** Atomically replace optional persisted project grants. */
  async replaceProjectGrants(
    grants: readonly PermissionGrant[],
  ): Promise<Result<null, PermissionPathError>> {
    return this.replaceGrants(grants, "project");
  }

  /** Replace grants derived from the currently loaded administrator ceiling. */
  async replaceAdministratorGrants(
    grants: readonly PermissionGrant[],
  ): Promise<Result<null, PermissionPathError>> {
    return this.replaceGrants(grants, "administrator");
  }

  private async replaceGrants(
    grants: readonly PermissionGrant[],
    lifetime: "administrator" | "project",
  ): Promise<Result<null, PermissionPathError>> {
    const canonical = await canonicalizeGrants(grants);
    if (!canonical.ok) return canonical;
    const replaced = addGrantsToPolicy(
      {
        ...this.policy,
        grants: this.policy.grants.filter(
          (grant) => grant.lifetime !== lifetime,
        ),
      },
      canonical.value,
    );
    if (!replaced.ok) return replaced;
    this.policy = replaced.value;
    return ok(null);
  }

  /** Atomically replace reloadable ceilings and persisted grants. */
  async replaceConfiguredPolicy(configuration: {
    readonly ceilings: readonly PermissionCeiling[];
    readonly administratorGrants: readonly PermissionGrant[];
    readonly projectGrants: readonly PermissionGrant[];
  }): Promise<Result<null, PermissionPathError>> {
    const ceilings = await canonicalizePermissionCeilings(
      configuration.ceilings,
    );
    if (!ceilings.ok) return ceilings;
    const grants = await canonicalizeGrants([
      ...configuration.administratorGrants,
      ...configuration.projectGrants,
    ]);
    if (!grants.ok) return grants;
    const candidate: PermissionPolicy = {
      ...reloadPermissionCeilings(this.policy, ceilings.value),
      grants: this.policy.grants.filter(
        ({ lifetime }) =>
          lifetime !== "administrator" && lifetime !== "project",
      ),
    };
    const replaced = addGrantsToPolicy(candidate, grants.value);
    if (!replaced.ok) return replaced;
    this.policy = replaced.value;
    return ok(null);
  }

  /** Replace ceilings without restarting the MCP process. */
  async reload(
    ceilings: readonly PermissionCeiling[],
  ): Promise<Result<null, PermissionPathError>> {
    const canonical = await canonicalizePermissionCeilings(ceilings);
    if (!canonical.ok) return canonical;
    this.policy = reloadPermissionCeilings(this.policy, canonical.value);
    return ok(null);
  }
}

/** Create one canonical policy and optional grants at the composition root. */
export const createPermissionAuthority = async (
  ceilings: readonly PermissionCeiling[],
  grants: readonly PermissionGrant[] = [],
): Promise<Result<PermissionAuthority, PermissionPathError>> => {
  const canonical = await canonicalizePermissionCeilings(ceilings);
  if (!canonical.ok) return canonical;
  const canonicalGrants = await canonicalizeGrants(grants);
  if (!canonicalGrants.ok) return canonicalGrants;
  const policy = addGrantsToPolicy(
    createPermissionPolicy(canonical.value),
    canonicalGrants.value,
  );
  return policy.ok ? ok(new PermissionAuthority(policy.value)) : policy;
};

const canonicalizeGrants = async (
  grants: readonly PermissionGrant[],
): Promise<Result<readonly PermissionGrant[], PermissionPathError>> => {
  const canonical: PermissionGrant[] = [];
  for (const grant of grants) {
    const canonicalGrant = await canonicalizeGrant(grant);
    if (!canonicalGrant.ok) return canonicalGrant;
    canonical.push(canonicalGrant.value);
  }
  return ok(canonical);
};

const addGrantsToPolicy = (
  initial: PermissionPolicy,
  grants: readonly PermissionGrant[],
): Result<PermissionPolicy, PermissionPathError> => {
  let policy = initial;
  for (const grant of grants) {
    const added = grantPermission(policy, grant);
    if (!added.ok)
      return err(
        new PermissionPathError(grant.grant_id, "io", { cause: added.error }),
      );
    policy = added.value;
  }
  return ok(policy);
};

const canonicalizeGrant = async (
  grant: PermissionGrant,
): Promise<Result<PermissionGrant, PermissionPathError>> => {
  const scope = await canonicalizeScope(grant, "read");
  return scope.ok ? ok({ ...grant, ...scope.value }) : scope;
};

const ceilingFor = (
  policy: PermissionPolicy,
  capability: PermissionRequest["capability"],
): PermissionScope | null =>
  policy.ceilings.find((ceiling) => ceiling.capability === capability) ?? null;
