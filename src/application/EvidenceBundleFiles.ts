import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  parseEvidenceBundle,
  serializeEvidenceBundle,
  type EvidenceBundle,
  type EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import { EvidenceFileError, EvidenceIntegrityError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

type EvidenceReadFailure = EvidenceFileError | EvidenceIntegrityError;
type EvidenceWriteFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate a bounded evidence bundle inside an approved root. */
export const readEvidenceBundle = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> => {
  if (policy.roots.length === 0)
    return err(new EvidenceFileError("read", "disabled"));
  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await isApproved(canonicalPath, policy.roots)))
      return err(new EvidenceFileError("read", "outside-root"));
    const stats = await lstat(canonicalPath);
    if (!stats.isFile()) return err(new EvidenceFileError("read", "not-file"));
    if (stats.size > policy.maxBytes)
      return err(new EvidenceFileError("read", "too-large"));
    const encoded = await readFile(canonicalPath);
    if (encoded.byteLength > policy.maxBytes)
      return err(new EvidenceFileError("read", "too-large"));
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded.toString("utf8"));
    } catch (cause: unknown) {
      return err(new EvidenceFileError("read", "invalid-json", { cause }));
    }
    const limits = validateJsonLimits(decoded, policy);
    if (!limits.ok) return limits;
    try {
      return ok(parseEvidenceBundle(decoded));
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Evidence bundle validation failed", {
          cause,
        }),
      );
    }
  } catch (cause: unknown) {
    return err(new EvidenceFileError("read", "io", { cause }));
  }
};

/** Atomically write deterministic evidence JSON inside an approved root. */
export const writeEvidenceBundle = async (
  bundle: EvidenceBundle,
  path: string,
  overwrite: boolean,
  policy: EvidenceFilePolicy,
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    EvidenceWriteFailure
  >
> => {
  if (policy.roots.length === 0)
    return err(new EvidenceFileError("write", "disabled"));
  let encoded: string;
  try {
    encoded = serializeEvidenceBundle(bundle);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause,
      }),
    );
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > policy.maxBytes)
    return err(new EvidenceFileError("write", "too-large"));
  try {
    const requestedPath = resolve(path);
    const canonicalParent = await realpath(dirname(requestedPath));
    const destination = resolve(canonicalParent, basename(requestedPath));
    if (!(await isApproved(destination, policy.roots)))
      return err(new EvidenceFileError("write", "outside-root"));
    const existing = await lstat(destination).catch((cause: unknown) => {
      if (isFileNotFound(cause)) return undefined;
      throw cause;
    });
    if (existing !== undefined) {
      if (!overwrite) return err(new EvidenceFileError("write", "exists"));
      if (!existing.isFile() || existing.isSymbolicLink())
        return err(new EvidenceFileError("write", "not-file"));
    }
    await writeFileAtomic(destination, encoded, {
      encoding: "utf8",
      mode: 0o600,
      fsync: true,
    });
    return ok({ path: requestedPath, bytes });
  } catch (cause: unknown) {
    return err(new EvidenceFileError("write", "io", { cause }));
  }
};

const isApproved = async (
  candidate: string,
  roots: readonly string[],
): Promise<boolean> => {
  for (const configuredRoot of roots) {
    const root = await realpath(resolve(configuredRoot));
    const relation = relative(root, candidate);
    if (
      relation === "" ||
      (!relation.startsWith("..") && !isAbsolute(relation))
    )
      return true;
  }
  return false;
};

const validateJsonLimits = (
  root: unknown,
  policy: EvidenceFilePolicy,
): Result<null, EvidenceFileError> => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > policy.maxNodes || current.depth > policy.maxDepth)
      return err(new EvidenceFileError("read", "too-large"));
    if (
      typeof current.value === "string" &&
      current.value.length > policy.maxStringLength
    )
      return err(new EvidenceFileError("read", "too-large"));
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (key.length > policy.maxStringLength)
        return err(new EvidenceFileError("read", "too-large"));
      pending.push({ value, depth: current.depth + 1 });
    }
  }
  return ok(null);
};

const isFileNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
