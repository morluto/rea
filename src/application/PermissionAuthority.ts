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

/** Stateful owner for permission evaluation, consumption, reload, and revoke. */
export class PermissionAuthority {
  private policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    this.policy = policy;
  }

  /** Canonicalize and authorize one exact operation before its side effect. */
  async authorize(
    request: PermissionRequest,
    access: "read" | "write",
    options: {
      readonly elicitationSupported?: boolean;
      readonly restartRequired?: boolean;
    } = {},
  ): Promise<
    Result<PermissionDecision, PermissionPathError | PermissionRequiredError>
  > {
    const evaluated = await this.explain(request, access, options);
    if (!evaluated.ok) return evaluated;
    const decision = evaluated.value;
    this.policy = consumePermission(this.policy, decision);
    return ok(decision);
  }

  /** Dry-run the exact shared evaluation without consuming a once grant. */
  async explain(
    request: PermissionRequest,
    access: "read" | "write",
    options: {
      readonly elicitationSupported?: boolean;
      readonly restartRequired?: boolean;
    } = {},
  ): Promise<
    Result<
      PermissionDecision & { readonly allowed: true },
      PermissionPathError | PermissionRequiredError
    >
  > {
    const canonical = await canonicalizePermissionRequest(request, access);
    if (!canonical.ok) return canonical;
    const decision = evaluatePermission(this.policy, canonical.value);
    if (!decision.allowed)
      return err(
        new PermissionRequiredError(
          canonical.value,
          decision.missing,
          ceilingFor(this.policy, canonical.value.capability),
          options.elicitationSupported ?? false,
          options.restartRequired ?? false,
        ),
      );
    return ok(decision);
  }

  /** Add authority beneath the administrator ceiling. */
  grant(grant: PermissionGrant): ReturnType<typeof grantPermission> {
    const result = grantPermission(this.policy, grant);
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

  /** Atomically replace optional persisted project grants. */
  async replaceProjectGrants(
    grants: readonly PermissionGrant[],
  ): Promise<Result<null, PermissionPathError>> {
    let candidate: PermissionPolicy = {
      ...this.policy,
      grants: this.policy.grants.filter(
        ({ lifetime }) => lifetime !== "project",
      ),
    };
    for (const grant of grants) {
      const canonical = await canonicalizeGrant(grant);
      if (!canonical.ok) return canonical;
      const added = grantPermission(candidate, canonical.value);
      if (!added.ok)
        return err(
          new PermissionPathError(grant.grant_id, "io", {
            cause: added.error,
          }),
        );
      candidate = added.value;
    }
    this.policy = candidate;
    return ok(null);
  }

  /** Replace grants derived from the currently loaded administrator ceiling. */
  async replaceAdministratorGrants(
    grants: readonly PermissionGrant[],
  ): Promise<Result<null, PermissionPathError>> {
    let candidate: PermissionPolicy = {
      ...this.policy,
      grants: this.policy.grants.filter(
        ({ lifetime }) => lifetime !== "administrator",
      ),
    };
    for (const grant of grants) {
      const canonical = await canonicalizeGrant(grant);
      if (!canonical.ok) return canonical;
      const added = grantPermission(candidate, canonical.value);
      if (!added.ok)
        return err(
          new PermissionPathError(grant.grant_id, "io", {
            cause: added.error,
          }),
        );
      candidate = added.value;
    }
    this.policy = candidate;
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
  let policy = createPermissionPolicy(canonical.value);
  for (const grant of grants) {
    const canonicalGrant = await canonicalizeGrant(grant);
    if (!canonicalGrant.ok) return canonicalGrant;
    const added = grantPermission(policy, canonicalGrant.value);
    if (!added.ok)
      return err(
        new PermissionPathError(grant.grant_id, "io", { cause: added.error }),
      );
    policy = added.value;
  }
  return ok(new PermissionAuthority(policy));
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
