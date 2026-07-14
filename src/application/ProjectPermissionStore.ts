import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import type { PermissionGrant } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";

const grantSchema = z.object({
  grant_id: z.string().min(1),
  capability: z.enum([
    "process_capture",
    "browser_observe",
    "evidence_read",
    "evidence_write",
    "investigation_input",
    "investigation_workspace_read",
    "investigation_workspace_write",
    "snapshot_read",
    "snapshot_write",
    "artifact_extract",
    "native_mount",
    "reference_read",
  ]),
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
  try {
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0)
      return err(new ProjectPermissionStoreError("not_owner_only"));
    const parsed = storeSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
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
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      path,
      `${JSON.stringify(candidate.data, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) {
      return err(new ProjectPermissionStoreError("not_owner_only"));
    }
    return ok(candidate.data);
  } catch (cause: unknown) {
    return err(new ProjectPermissionStoreError("io", { cause }));
  }
};

/** Revoke one grant while serializing the complete read-modify-write cycle. */
export const revokeProjectPermissionGrant = async (
  path: string,
  projectRoot: string,
  grantId: string,
): Promise<Result<boolean, ProjectPermissionStoreError>> => {
  let lock: PermissionStoreLock | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const acquired = await acquirePermissionStoreLock(path);
    if (!acquired.ok) return acquired;
    lock = acquired.value;
    const current = await readProjectPermissionStore(path, projectRoot);
    if (!current.ok) return current;
    const grants = current.value?.grants ?? [];
    const retained = grants.filter(({ grant_id }) => grant_id !== grantId);
    if (retained.length === grants.length) return ok(false);
    const written = await writeProjectPermissionStore(
      path,
      projectRoot,
      retained,
    );
    return written.ok ? ok(true) : written;
  } catch (cause: unknown) {
    return err(new ProjectPermissionStoreError("io", { cause }));
  } finally {
    if (lock !== undefined) await releasePermissionStoreLock(lock);
  }
};

interface PermissionStoreLock {
  readonly path: string;
  readonly handle: FileHandle;
}

const acquirePermissionStoreLock = async (
  destination: string,
): Promise<Result<PermissionStoreLock, ProjectPermissionStoreError>> => {
  const path = `${destination}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return ok(await createPermissionStoreLock(path));
    } catch (cause: unknown) {
      if (!isAlreadyExists(cause))
        return err(new ProjectPermissionStoreError("io", { cause }));
      if (await removeStalePermissionStoreLock(path)) continue;
      if (attempt === 99)
        return err(new ProjectPermissionStoreError("locked", { cause }));
      await delay(10);
    }
  }
  return err(new ProjectPermissionStoreError("locked"));
};

const createPermissionStoreLock = async (
  path: string,
): Promise<PermissionStoreLock> => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${String(process.pid)}\n`, "utf8");
    await handle.sync();
    return { path, handle };
  } catch (cause: unknown) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw cause;
  }
};

const removeStalePermissionStoreLock = async (
  path: string,
): Promise<boolean> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32)
      return false;
    const encoded = (await readFile(path, "utf8")).trim();
    if (!/^[1-9][0-9]{0,9}$/u.test(encoded)) return false;
    if (processIsAlive(Number(encoded))) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return errorCode(cause) !== "ESRCH";
  }
};

const releasePermissionStoreLock = async (
  lock: PermissionStoreLock,
): Promise<void> => {
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch(() => undefined);
};

const isNotFound = (cause: unknown): boolean => errorCode(cause) === "ENOENT";

const isAlreadyExists = (cause: unknown): boolean =>
  errorCode(cause) === "EEXIST";

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
