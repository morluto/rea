import {
  createStoreFileLock,
  removeStaleStoreFileLock,
  type StoreFileLock,
} from "./StoreFileLock.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { isPathWithinRoot } from "../domain/localPath.js";
import writeFileAtomic from "write-file-atomic";

import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { isJsonWithinLimits } from "../domain/jsonLimits.js";
import { InvestigationWorkspaceError } from "../domain/errors.js";
import {
  parseInvestigationWorkspace,
  serializeInvestigationWorkspace,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { err, ok, type Result } from "../domain/result.js";
import { canonicalizeConfiguredRoots } from "./ConfiguredRoots.js";

type WorkspaceResult<Value> = Result<Value, InvestigationWorkspaceError>;

/** Parser, serializer, and CAS transition owned by one revisioned workspace. */
export interface RevisionedWorkspaceCodec<Document> {
  readonly parse: (input: unknown) => Document;
  readonly serialize: (document: Document) => string;
  readonly validateNext: (
    current: Document | null,
    next: Document,
    expectedRevision: number | null,
  ) => WorkspaceResult<null>;
}

const investigationWorkspaceCodec: RevisionedWorkspaceCodec<InvestigationWorkspace> =
  {
    parse: parseInvestigationWorkspace,
    serialize: serializeInvestigationWorkspace,
    validateNext: validateNextRevision,
  };

/** Read a validated workspace, returning null only when it does not exist. */
export const readInvestigationWorkspace = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<WorkspaceResult<InvestigationWorkspace | null>> =>
  readRevisionedWorkspace(path, policy, investigationWorkspaceCodec);

/** Read one root-confined, owner-only revisioned workspace document. */
export const readRevisionedWorkspace = async <Document>(
  path: string,
  policy: EvidenceFilePolicy,
  codec: RevisionedWorkspaceCodec<Document>,
): Promise<WorkspaceResult<Document | null>> => {
  if (policy.roots.length === 0)
    return err(new InvestigationWorkspaceError("read", "disabled"));
  try {
    const destination = await resolveDestination(path, policy.roots);
    if (destination === null)
      return err(new InvestigationWorkspaceError("read", "outside-root"));
    return await readWorkspaceFile(destination, policy, codec);
  } catch (cause: unknown) {
    return err(new InvestigationWorkspaceError("read", "io", { cause }));
  }
};

export interface RevisionedWorkspaceWriteInput<Document> {
  readonly document: Document;
  readonly expectedRevision: number | null;
  readonly codec: RevisionedWorkspaceCodec<Document>;
}

/** Atomically append one CAS-linked workspace revision under an exclusive lock. */
export const writeInvestigationWorkspace = async (
  workspace: InvestigationWorkspace,
  path: string,
  expectedRevision: number | null,
  policy: EvidenceFilePolicy,
): Promise<
  WorkspaceResult<{ readonly path: string; readonly bytes: number }>
> =>
  writeRevisionedWorkspace(path, policy, {
    document: workspace,
    expectedRevision,
    codec: investigationWorkspaceCodec,
  });

/** Atomically append one validated CAS-linked revision under an exclusive lock. */
export const writeRevisionedWorkspace = async <Document>(
  path: string,
  policy: EvidenceFilePolicy,
  input: RevisionedWorkspaceWriteInput<Document>,
): Promise<
  WorkspaceResult<{ readonly path: string; readonly bytes: number }>
> => {
  const { document, expectedRevision, codec } = input;
  if (policy.roots.length === 0)
    return err(new InvestigationWorkspaceError("update", "disabled"));
  let encoded: string;
  try {
    encoded = codec.serialize(document);
  } catch (cause: unknown) {
    return err(
      new InvestigationWorkspaceError("update", "integrity", { cause }),
    );
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > policy.maxBytes)
    return err(new InvestigationWorkspaceError("update", "too-large"));
  let lock: StoreFileLock | undefined;
  try {
    const destination = await resolveDestination(path, policy.roots);
    if (destination === null)
      return err(new InvestigationWorkspaceError("update", "outside-root"));
    const acquired = await acquireLock(destination);
    if (!acquired.ok) return acquired;
    lock = acquired.value;
    const current = await readWorkspaceFile(destination, policy, codec);
    if (!current.ok) return current;
    const checked = codec.validateNext(
      current.value,
      document,
      expectedRevision,
    );
    if (!checked.ok) return checked;
    await writeFileAtomic(destination, encoded, {
      encoding: "utf8",
      mode: 0o600,
      fsync: true,
    });
    return ok({ path: resolve(path), bytes });
  } catch (cause: unknown) {
    return err(new InvestigationWorkspaceError("update", "io", { cause }));
  } finally {
    if (lock !== undefined) await lock.release();
  }
};

const resolveDestination = async (
  path: string,
  roots: readonly string[],
): Promise<string | null> => {
  const requested = resolve(path);
  const canonicalParent = await realpath(dirname(requested));
  const destination = resolve(canonicalParent, basename(requested));
  for (const root of await canonicalizeConfiguredRoots(
    roots.map((configuredRoot) => resolve(configuredRoot)),
  )) {
    if (isPathWithinRoot(root, destination)) return destination;
  }
  return null;
};

const readWorkspaceFile = async <Document>(
  destination: string,
  policy: EvidenceFilePolicy,
  codec: RevisionedWorkspaceCodec<Document>,
): Promise<WorkspaceResult<Document | null>> => {
  const stats = await lstat(destination).catch((cause: unknown) => {
    if (isFileNotFound(cause)) return undefined;
    throw cause;
  });
  if (stats === undefined) return ok(null);
  if (!stats.isFile() || stats.isSymbolicLink())
    return err(new InvestigationWorkspaceError("read", "not-file"));
  if (stats.size > policy.maxBytes)
    return err(new InvestigationWorkspaceError("read", "too-large"));
  const encoded = await readFile(destination);
  if (encoded.byteLength > policy.maxBytes)
    return err(new InvestigationWorkspaceError("read", "too-large"));
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded.toString("utf8"));
  } catch (cause: unknown) {
    return err(
      new InvestigationWorkspaceError("read", "invalid-json", { cause }),
    );
  }
  if (!isJsonWithinLimits(decoded, policy))
    return err(new InvestigationWorkspaceError("read", "too-large"));
  try {
    return ok(codec.parse(decoded));
  } catch (cause: unknown) {
    return err(new InvestigationWorkspaceError("read", "integrity", { cause }));
  }
};

const acquireLock = async (
  destination: string,
): Promise<WorkspaceResult<StoreFileLock>> => {
  const path = `${destination}.lock`;
  try {
    return ok(await createStoreFileLock(path));
  } catch (cause: unknown) {
    if (isAlreadyExists(cause) && (await removeStaleStoreFileLock(path))) {
      try {
        return ok(await createStoreFileLock(path));
      } catch (retryCause: unknown) {
        return err(
          new InvestigationWorkspaceError(
            "update",
            isAlreadyExists(retryCause) ? "locked" : "io",
            { cause: retryCause },
          ),
        );
      }
    }
    return err(
      new InvestigationWorkspaceError(
        "update",
        isAlreadyExists(cause) ? "locked" : "io",
        { cause },
      ),
    );
  }
};

function validateNextRevision(
  current: InvestigationWorkspace | null,
  next: InvestigationWorkspace,
  expectedRevision: number | null,
): WorkspaceResult<null> {
  if ((current?.revision ?? null) !== expectedRevision)
    return err(new InvestigationWorkspaceError("update", "revision-conflict"));
  if (current === null) {
    return next.revision === 1 && next.previous_revision_digest === null
      ? ok(null)
      : err(new InvestigationWorkspaceError("update", "revision-conflict"));
  }
  if (current.name !== next.name || current.workspace_id !== next.workspace_id)
    return err(new InvestigationWorkspaceError("update", "name-conflict"));
  return next.revision === current.revision + 1 &&
    next.previous_revision_digest === current.revision_digest
    ? ok(null)
    : err(new InvestigationWorkspaceError("update", "revision-conflict"));
}

const isFileNotFound = (cause: unknown): boolean =>
  errorCode(cause) === "ENOENT";

const isAlreadyExists = (cause: unknown): boolean =>
  errorCode(cause) === "EEXIST";

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
