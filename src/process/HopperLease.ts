import { realpath } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactResourceScope } from "../resources/index.js";
import {
  acquireOwnedLease,
  type LeaseAcquisition,
  type LeaseFailure,
  type LeaseFailureFactory,
} from "./OwnedLease.js";

/** Shared private parent of Hopper lease sockets; it outlives individual sessions. */
export const HOPPER_TARGET_LEASE_DIRECTORY = join(
  "/tmp",
  `rea-hopper-${process.getuid?.() ?? 0}`,
);

/**
 * Reserve one Hopper lease identity in the shared lease directory. The caller
 * supplies the failure its own layer reports.
 */
export const acquireHopperLease = (input: {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly directory?: string;
  readonly resources?: ArtifactResourceScope | undefined;
  readonly failure: LeaseFailureFactory;
}): Promise<LeaseAcquisition> =>
  acquireOwnedLease({
    identity: input.identity,
    runId: input.runId,
    directory: input.directory ?? HOPPER_TARGET_LEASE_DIRECTORY,
    failure: input.failure,
    resources: input.resources,
  });

/** Serialize approved publication/repair of one canonical signed-package entry. */
export const acquireHopperReleaseCacheLease = async (input: {
  readonly cacheDirectory: string;
  readonly launcherSha256: string;
  readonly runId: string;
  readonly resources?: ArtifactResourceScope | undefined;
  readonly failure: LeaseFailureFactory;
}): Promise<LeaseAcquisition> =>
  acquireHopperLease({
    runId: input.runId,
    resources: input.resources,
    failure: input.failure,
    identity: {
      cacheDirectory: await realpath(input.cacheDirectory),
      launcherSha256: input.launcherSha256,
      operation: "signed-package-retention",
    },
  });

/** What a Hopper lease failure means for the caller, by its kind. */
export const hopperLeaseMessage = (failure: LeaseFailure): string => {
  switch (failure.kind) {
    case "directory_create":
      return "REA could not create its private Hopper lease directory.";
    case "directory_not_private":
      return "REA's Hopper lease directory is not a private directory owned by this user.";
    case "directory_permissions":
      return "REA's Hopper lease directory permissions could not be secured.";
    case "directory_access_denied":
      return `REA could not access its Hopper lease directory at ${JSON.stringify(failure.directory)}. Check its ownership and parent-directory access. For a directory you own, restore owner-only read, write, and search permissions (0700), then retry.`;
    case "socket_permissions":
      return "REA could not secure its lease socket permissions.";
    case "directory_close":
      return "REA could not confirm closure of its Hopper lease directory handle.";
    case "directory_inspect":
      return "REA could not inspect its private Hopper lease directory.";
    case "recovery_busy":
      return `REA could not reserve Hopper lease recovery at ${JSON.stringify(failure.path)}; the existing socket was left unchanged. Retry after concurrent startup finishes. If recovery was interrupted, stop REA sessions and remove this recovery directory before retrying.`;
    case "recovery_create":
      return `REA could not create its Hopper recovery directory at ${JSON.stringify(failure.path)}; the existing socket was left unchanged. Check the parent directory's write access before retrying.`;
    case "recovery_remove":
      return `REA could not remove its Hopper recovery directory at ${JSON.stringify(failure.path)}. Check this directory's write access before retrying.`;
    case "owner_unverified":
      return `REA could not verify the existing Hopper lease (${failure.reason}); it was left unchanged. Retry when the owning REA session is responsive.`;
    case "unrecoverable":
      return "REA could not reserve Hopper for this request. Close competing REA sessions and retry.";
  }
};
