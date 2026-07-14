import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import writeFileAtomic from "write-file-atomic";

import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { EvidenceFileError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { canonicalizeConfiguredRoots } from "./ConfiguredRoots.js";

/** Read bounded JSON data from a regular file beneath an approved root. */
export const readBoundedJson = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<Result<unknown, EvidenceFileError>> => {
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
    return limits.ok ? ok(decoded) : limits;
  } catch (cause: unknown) {
    return err(new EvidenceFileError("read", "io", { cause }));
  }
};

/** Atomically write bounded text to a regular file beneath an approved root. */
export const writeBoundedText = async (
  encoded: string,
  path: string,
  overwrite: boolean,
  policy: EvidenceFilePolicy,
): Promise<
  Result<{ readonly path: string; readonly bytes: number }, EvidenceFileError>
> => {
  if (policy.roots.length === 0)
    return err(new EvidenceFileError("write", "disabled"));
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
  for (const root of await canonicalizeConfiguredRoots(
    roots.map((configuredRoot) => resolve(configuredRoot)),
  )) {
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
