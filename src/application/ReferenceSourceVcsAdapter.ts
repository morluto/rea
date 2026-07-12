import fs from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { resolveRef } from "isomorphic-git";

export type ReferenceSourceVcsInfo =
  | {
      readonly kind: "git";
      readonly head: string;
      readonly dirty: boolean | null;
    }
  | { readonly kind: "none"; readonly head: null; readonly dirty: null }
  | { readonly kind: "unknown"; readonly head: null; readonly dirty: null };

/**
 * Read Git metadata for a directory using isomorphic-git.
 *
 * No git subprocess or network is used; only the local `.git` object store is read.
 */
export const readReferenceSourceVcs = async (
  root: string,
  signal?: AbortSignal,
): Promise<ReferenceSourceVcsInfo> => {
  if (isAborted(signal)) return { kind: "unknown", head: null, dirty: null };
  try {
    await lstat(join(root, ".git"));
  } catch (cause: unknown) {
    return errorCode(cause) === "ENOENT"
      ? { kind: "none", head: null, dirty: null }
      : { kind: "unknown", head: null, dirty: null };
  }
  try {
    const head = await resolveRef({ fs, dir: root, ref: "HEAD" });
    if (isAborted(signal)) return { kind: "unknown", head: null, dirty: null };
    return { kind: "git", head, dirty: null };
  } catch {
    return { kind: "unknown", head: null, dirty: null };
  }
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
