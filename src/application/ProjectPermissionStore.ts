import {
  createStoreFileLock,
  removeStaleStoreFileLock,
  type StoreFileLock,
} from "./StoreFileLock.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import {
  PERMISSION_CAPABILITIES,
  type PermissionGrant,
} from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";

const grantSchema = z.object({
  grant_id: z.string().min(1),
  capability: z.enum(PERMISSION_CAPABILITIES),
  roots: z.array(z.string()),
  executables: z.array(z.string()),
  environment_names: z.array(z.string()),
  origins: z.array(z.string()).optional(),
  network: z.enum(["none", "loopback", "external"]),
  mount: z.boolean(),
  lifetime: z.literal("project"),
  operation_identity: z.string().nullable(),
  expires_at: z.iso.datetime().nullable(),
});

const storeSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string().regex(/^project_[a-f0-9]{64}$/u),
  project_root: z.string(),
  grants: z.array(grantSchema).max(1_000),
});

export type ProjectPermissionStore = z.infer<typeof storeSchema>;

/** Owner-only project policy persistence failure. */
export class ProjectPermissionStoreError extends Error {
  readonly _tag = "ProjectPermissionStoreError" as const;

  constructor(
    readonly reason:
      | "project_not_found"
      | "not_owner_only"
      | "invalid"
      | "locked"
      | "io",
    options?: ErrorOptions,
  ) {
    super(`Project permission store failed: ${reason}`, options);
  }
}

/** Derive relocation-explicit project identity from its canonical root. */
const identifyPermissionProject = async (
  projectRoot: string,
): Promise<
  Result<
    { readonly id: string; readonly root: string },
    ProjectPermissionStoreError
  >
> => {
  try {
    const root = await realpath(projectRoot);
    return ok({
      id: `project_${createHash("sha256").update(root).digest("hex")}`,
      root,
    });
  } catch (cause: unknown) {
    return err(new ProjectPermissionStoreError("project_not_found", { cause }));
  }
};

/** Read and validate an owner-only store bound to the requested project. */
export const readProjectPermissionStore = async (
  path: string,
  projectRoot: string,
): Promise<
  Result<ProjectPermissionStore | null, ProjectPermissionStoreError>
> => {
  const project = await identifyPermissionProject(projectRoot);
  if (!project.ok) return project;
  if (process.getuid === undefined)
    return err(new ProjectPermissionStoreError("not_owner_only"));
  let handle: FileHandle | undefined;
  try {
    const opened = await openPrivateStore(path);
    if (!opened.ok) return opened;
    if (opened.value === null) return ok(null);
    handle = opened.value;
    const encoded = await handle.readFile("utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch (cause: unknown) {
      return err(new ProjectPermissionStoreError("invalid", { cause }));
    }
    const parsed = storeSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.project_id !== project.value.id ||
      parsed.data.project_root !== project.value.root
    )
      return err(new ProjectPermissionStoreError("invalid"));
    return ok(parsed.data);
  } catch (cause: unknown) {
    if (isNotFound(cause)) return ok(null);
    return err(new ProjectPermissionStoreError("io", { cause }));
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Atomically replace explicit project grants with owner-only permissions. */
export const writeProjectPermissionStore = async (
  path: string,
  projectRoot: string,
  grants: readonly PermissionGrant[],
): Promise<Result<ProjectPermissionStore, ProjectPermissionStoreError>> => {
  const project = await identifyPermissionProject(projectRoot);
  if (!project.ok) return project;
  const candidate = storeSchema.safeParse({
    schema_version: 1,
    project_id: project.value.id,
    project_root: project.value.root,
    grants,
  });
  if (!candidate.success)
    return err(
      new ProjectPermissionStoreError("invalid", { cause: candidate.error }),
    );
  if (process.getuid === undefined)
    return err(new ProjectPermissionStoreError("not_owner_only"));
  return withPermissionStoreLock(path, () =>
    writePreparedPermissionStore(path, projectRoot, candidate.data),
  );
};

const writePreparedPermissionStore = async (
  path: string,
  projectRoot: string,
  candidate: ProjectPermissionStore,
): Promise<Result<ProjectPermissionStore, ProjectPermissionStoreError>> => {
  await writeFileAtomic(path, `${JSON.stringify(candidate, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const verified = await readProjectPermissionStore(path, projectRoot);
  if (!verified.ok) return verified;
  if (
    verified.value === null ||
    JSON.stringify(verified.value) !== JSON.stringify(candidate)
  )
    return err(new ProjectPermissionStoreError("invalid"));
  return ok(candidate);
};

/** Revoke one grant while serializing the complete read-modify-write cycle. */
export const revokeProjectPermissionGrant = async (
  path: string,
  projectRoot: string,
  grantId: string,
): Promise<Result<boolean, ProjectPermissionStoreError>> =>
  withPermissionStoreLock(path, async () => {
    const current = await readProjectPermissionStore(path, projectRoot);
    if (!current.ok) return current;
    if (current.value === null) return ok(false);
    const retained = current.value.grants.filter(
      ({ grant_id }) => grant_id !== grantId,
    );
    if (retained.length === current.value.grants.length) return ok(false);
    const written = await writePreparedPermissionStore(path, projectRoot, {
      ...current.value,
      grants: retained,
    });
    return written.ok ? ok(true) : written;
  });

const withPermissionStoreLock = async <Value>(
  path: string,
  action: () => Promise<Result<Value, ProjectPermissionStoreError>>,
): Promise<Result<Value, ProjectPermissionStoreError>> => {
  let lock: StoreFileLock | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const acquired = await acquirePermissionStoreLock(path);
    if (!acquired.ok) return acquired;
    lock = acquired.value;
    return await action();
  } catch (cause: unknown) {
    return err(new ProjectPermissionStoreError("io", { cause }));
  } finally {
    if (lock !== undefined) await lock.release();
  }
};

const acquirePermissionStoreLock = async (
  destination: string,
): Promise<Result<StoreFileLock, ProjectPermissionStoreError>> => {
  const path = `${destination}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return ok(await createStoreFileLock(path));
    } catch (cause: unknown) {
      if (!isAlreadyExists(cause))
        return err(new ProjectPermissionStoreError("io", { cause }));
      if (await removeStaleStoreFileLock(path)) continue;
      if (attempt === 99)
        return err(new ProjectPermissionStoreError("locked", { cause }));
      await delay(10);
    }
  }
  return err(new ProjectPermissionStoreError("locked"));
};

const isNotFound = (cause: unknown): boolean => errorCode(cause) === "ENOENT";

const openPrivateStore = async (
  path: string,
): Promise<Result<FileHandle | null, ProjectPermissionStoreError>> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!privateRegularFile(metadata)) {
      await handle.close();
      return err(new ProjectPermissionStoreError("not_owner_only"));
    }
    return ok(handle);
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    if (isNotFound(cause)) return ok(null);
    return err(
      new ProjectPermissionStoreError(
        isSymlinkRefusal(cause) ? "not_owner_only" : "io",
        { cause },
      ),
    );
  }
};

const privateRegularFile = (
  metadata: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  metadata.isFile() &&
  !metadata.isSymbolicLink() &&
  (Number(metadata.mode) & 0o077) === 0 &&
  process.getuid !== undefined &&
  metadata.uid === process.getuid();

const isAlreadyExists = (cause: unknown): boolean =>
  errorCode(cause) === "EEXIST";

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;

const isSymlinkRefusal = (cause: unknown): boolean =>
  errorCode(cause) === "ELOOP" || errorCode(cause) === "EMLINK";
