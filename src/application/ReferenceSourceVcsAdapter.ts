import fs from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    const head = await resolveSourceHead(root);
    if (isAborted(signal)) return { kind: "unknown", head: null, dirty: null };
    return { kind: "git", head, dirty: null };
  } catch (cause: unknown) {
    // Unresolvable refs mean VCS state is unknown, not absent.
    void cause;
    return { kind: "unknown", head: null, dirty: null };
  }
};

const resolveSourceHead = async (root: string): Promise<string> => {
  // isomorphic-git is loaded on first use so CLI and MCP startup skip it.
  const { resolveRef } = await import("isomorphic-git");
  const dotgit = join(root, ".git");
  if (!(await lstat(dotgit)).isFile())
    return resolveRef({ fs, dir: root, ref: "HEAD" });
  const pointer = (await readFile(dotgit, "utf8")).replace(/\r?\n$/u, "");
  if (!pointer.startsWith("gitdir: ") || pointer.length === 8)
    throw new Error("Invalid Git directory pointer");
  const gitdir = resolve(root, pointer.slice(8));
  let commonDirectory: string;
  try {
    commonDirectory = resolve(
      gitdir,
      (await readFile(join(gitdir, "commondir"), "utf8")).replace(
        /\r?\n$/u,
        "",
      ),
    );
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") throw cause;
    return resolveRef({ fs, dir: root, gitdir, ref: "HEAD" });
  }
  const head = (await readFile(join(gitdir, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref: "))
    return resolveRef({ fs, dir: root, gitdir, ref: "HEAD" });
  const ref = head.slice(5);
  const privateRef = ["refs/bisect/", "refs/rewritten/", "refs/worktree/"].some(
    (prefix) => ref.startsWith(prefix),
  );
  return resolveRef({
    fs,
    dir: root,
    gitdir: privateRef ? gitdir : commonDirectory,
    ref,
  });
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
