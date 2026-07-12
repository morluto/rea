import fs from "node:fs";

import { log, statusMatrix } from "isomorphic-git";

export type ReferenceSourceVcsInfo =
  | { readonly kind: "git"; readonly head: string; readonly dirty: boolean }
  | { readonly kind: "none"; readonly head: null; readonly dirty: null }
  | { readonly kind: "unknown"; readonly head: null; readonly dirty: null };

/**
 * Read Git metadata for a directory using isomorphic-git.
 *
 * No git subprocess or network is used; only the local `.git` object store is read.
 */
export const readReferenceSourceVcs = async (
  root: string,
): Promise<ReferenceSourceVcsInfo> => {
  try {
    const commits = await log({
      fs,
      dir: root,
      ref: "HEAD",
      depth: 1,
      cache: {},
    });
    if (commits.length === 0)
      return { kind: "unknown", head: null, dirty: null };

    const head = commits[0]?.oid;
    if (head === undefined) return { kind: "unknown", head: null, dirty: null };

    let dirty = false;
    try {
      const matrix = await statusMatrix({
        fs,
        dir: root,
        ref: head,
        cache: {},
      });
      for (const row of matrix) {
        const [, headStatus, workdirStatus, stageStatus] = row;
        if (headStatus !== 1 || workdirStatus !== 1 || stageStatus !== 1) {
          dirty = true;
          break;
        }
      }
    } catch {
      dirty = true;
    }

    return { kind: "git", head, dirty };
  } catch {
    return { kind: "none", head: null, dirty: null };
  }
};
