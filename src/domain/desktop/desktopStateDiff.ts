import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { DesktopStateChange } from "./desktopCapture.js";

/** Metadata recorded for one path by a checkpoint's stat walk. */
export interface DesktopPathState {
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly mode: number;
  readonly mtime_ns: string;
  readonly inode: string;
}

/** One stat walk and the places where it established what exists. */
export interface DesktopWalk {
  readonly entries: ReadonlyMap<string, DesktopPathState>;
  /** Directories whose every entry the walk recorded. */
  readonly listed: ReadonlySet<string>;
  /** Roots whose presence or absence the walk established. */
  readonly roots: ReadonlySet<string>;
}

/** A difference between two walks before attribution and content are added. */
export interface DesktopPathDifference {
  readonly path: string;
  readonly kind: DesktopStateChange["kind"];
  readonly before: DesktopPathState | null;
  readonly after: DesktopPathState | null;
}

/** Directories only appear or disappear; their own size and time track their entries. */
const sameContentIdentity = (
  before: DesktopPathState,
  after: DesktopPathState,
): boolean =>
  before.type === "directory" ||
  (before.size === after.size &&
    before.mtime_ns === after.mtime_ns &&
    before.inode === after.inode &&
    before.mode === after.mode);

const parentOf = (path: string): string =>
  path.slice(0, Math.max(1, path.lastIndexOf("/")));

/**
 * Whether the walk established this path's presence or absence: it is a
 * checked root, or its nearest ancestor present in the walk was either fully
 * listed or not a directory, which nothing can be inside.
 */
const covers = (walk: DesktopWalk, path: string): boolean => {
  if (walk.roots.has(path)) return true;
  for (let directory = parentOf(path); ; directory = parentOf(directory)) {
    const ancestor = walk.entries.get(directory);
    if (ancestor !== undefined)
      return ancestor.type !== "directory" || walk.listed.has(directory);
    if (walk.roots.has(directory)) return true;
    if (directory === "/") return false;
  }
};

/**
 * Compare two walks of the same roots, in code-point order of path. A path
 * counts as created or deleted only where both walks checked its parent; the
 * rest are counted as unconfirmed rather than reported.
 */
export const diffDesktopStates = (
  before: DesktopWalk,
  after: DesktopWalk,
): {
  readonly differences: readonly DesktopPathDifference[];
  readonly unconfirmed: number;
} => {
  const differences: DesktopPathDifference[] = [];
  let unconfirmed = 0;
  for (const [path, previous] of before.entries) {
    const next = after.entries.get(path);
    if (next === undefined) {
      if (covers(after, path))
        differences.push({
          path,
          kind: "deleted",
          before: previous,
          after: null,
        });
      else unconfirmed += 1;
    } else if (next.type !== previous.type)
      differences.push({
        path,
        kind: "type_changed",
        before: previous,
        after: next,
      });
    else if (!sameContentIdentity(previous, next))
      differences.push({
        path,
        kind: "modified",
        before: previous,
        after: next,
      });
  }
  for (const [path, next] of after.entries)
    if (!before.entries.has(path)) {
      if (covers(before, path))
        differences.push({ path, kind: "created", before: null, after: next });
      else unconfirmed += 1;
    }
  return {
    differences: differences.sort((left, right) =>
      compareUnicodeCodePoints(left.path, right.path),
    ),
    unconfirmed,
  };
};

/** Whether a path is one of the roots or lies beneath one. */
export const isWithinAny = (path: string, roots: readonly string[]): boolean =>
  roots.some(
    (root) =>
      path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
