import fs from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRegularFile, readRegularFileText } from "./RegularFileRead.js";

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
    const head = await resolveSourceHead(root, signal);
    if (isAborted(signal)) return { kind: "unknown", head: null, dirty: null };
    return { kind: "git", head, dirty: null };
  } catch (cause: unknown) {
    // Unresolvable refs mean VCS state is unknown, not absent.
    void cause;
    return { kind: "unknown", head: null, dirty: null };
  }
};

const resolveSourceHead = async (
  root: string,
  signal?: AbortSignal,
): Promise<string> => {
  // isomorphic-git is loaded on first use so CLI and MCP startup skip it.
  const { resolveRef } = await import("isomorphic-git");
  let failedRead: { readonly cause: unknown } | undefined;
  const referenceFs = {
    ...fs,
    promises: {
      ...fs.promises,
      // isomorphic-git treats every read failure as absence. Preserve real
      // failures so a readable packed ref cannot hide an unreadable loose ref.
      readFile: async (
        path: string | undefined,
        options:
          | BufferEncoding
          | { readonly encoding?: BufferEncoding | null }
          | null = null,
      ) => {
        // The library probes readFile() without a path to detect promise APIs.
        // Reject that invocation without attributing it to a source read.
        if (path === undefined)
          throw new TypeError("Git filesystem read requires a path");
        try {
          const bytes = await readRegularFile(path, { signal });
          const encoding =
            typeof options === "string" ? options : options?.encoding;
          return encoding === undefined || encoding === null
            ? bytes
            : bytes.toString(encoding);
        } catch (cause: unknown) {
          if (errorCode(cause) !== "ENOENT") failedRead ??= { cause };
          throw cause;
        }
      },
    },
  };
  const readRef = async (options: {
    readonly gitdir?: string;
    readonly ref: string;
  }) => {
    const head = await resolveRef({ fs: referenceFs, dir: root, ...options });
    signal?.throwIfAborted();
    if (failedRead !== undefined) throw failedRead.cause;
    return head;
  };
  const dotgit = join(root, ".git");
  if (!(await lstat(dotgit)).isFile()) return readRef({ ref: "HEAD" });
  const pointer = (await readRegularFileText(dotgit, { signal })).replace(
    /\r?\n$/u,
    "",
  );
  if (!pointer.startsWith("gitdir: ") || pointer.length === 8)
    throw new Error("Invalid Git directory pointer");
  const gitdir = resolve(root, pointer.slice(8));
  let commonDirectory: string;
  try {
    commonDirectory = resolve(
      gitdir,
      (
        await readRegularFileText(join(gitdir, "commondir"), { signal })
      ).replace(/\r?\n$/u, ""),
    );
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") throw cause;
    return readRef({ gitdir, ref: "HEAD" });
  }
  const head = (
    await readRegularFileText(join(gitdir, "HEAD"), { signal })
  ).trim();
  if (!head.startsWith("ref: ")) return readRef({ gitdir, ref: "HEAD" });
  const ref = head.slice(5);
  const privateRef = ["refs/bisect/", "refs/rewritten/", "refs/worktree/"].some(
    (prefix) => ref.startsWith(prefix),
  );
  return readRef({
    gitdir: privateRef ? gitdir : commonDirectory,
    ref,
  });
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
