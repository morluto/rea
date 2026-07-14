import {
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import type { PermissionCapability } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  PermissionPathError,
  type PermissionAuthority,
} from "./PermissionAuthority.js";

interface RootPermissionRequest {
  readonly capability: PermissionCapability;
  readonly roots: readonly string[];
  readonly access: "read" | "write";
  readonly operation: string;
}

/** Authorize one root-scoped operation and project policy path failures. */
export const authorizeRootPermission = async (
  authority: PermissionAuthority,
  request: RootPermissionRequest,
): Promise<Result<null, AnalysisError>> => {
  const authorized = await authority.authorize(
    {
      capability: request.capability,
      roots: request.roots,
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: `${request.operation}:${request.capability}:${request.roots.join(":")}`,
    },
    request.access,
  );
  return authorized.ok
    ? ok(null)
    : err(
        authorized.error instanceof PermissionRequiredError
          ? authorized.error
          : new AnalysisProtocolError(authorized.error.message, {
              cause: authorized.error,
            }),
      );
};

export interface DeferredFileWriteAuthorization {
  readonly authorizeWrite: () => Promise<Result<null, AnalysisError>>;
}

/** Authorize an existing file read and defer write authority until requested. */
export const authorizeFileReadWithDeferredWrite = async (
  authority: PermissionAuthority,
  input: {
    readonly path: string;
    readonly readCapability: PermissionCapability;
    readonly writeCapability: PermissionCapability;
    readonly operation: string;
  },
): Promise<Result<DeferredFileWriteAuthorization, AnalysisError>> => {
  const read = await authority.authorize(
    {
      capability: input.readCapability,
      roots: [input.path],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: `${input.operation}:${input.readCapability}:${input.path}`,
    },
    "read",
  );
  let writeAuthorization: Promise<Result<null, AnalysisError>> | undefined;
  if (!read.ok) {
    if (
      !(read.error instanceof PermissionPathError) ||
      read.error.reason !== "not_found"
    )
      return err(
        read.error instanceof PermissionRequiredError
          ? read.error
          : new AnalysisProtocolError(read.error.message, {
              cause: read.error,
            }),
      );
    writeAuthorization = authorizeRootPermission(authority, {
      capability: input.writeCapability,
      roots: [input.path],
      access: "write",
      operation: input.operation,
    });
    const authorized = await writeAuthorization;
    if (!authorized.ok) return authorized;
  }
  return ok({
    authorizeWrite: () =>
      (writeAuthorization ??= authorizeRootPermission(authority, {
        capability: input.writeCapability,
        roots: [input.path],
        access: "write",
        operation: input.operation,
      })),
  });
};
