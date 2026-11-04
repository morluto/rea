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

/** Compare two walks of the same roots, in code-point order of path. */
export const diffDesktopStates = (
  before: ReadonlyMap<string, DesktopPathState>,
  after: ReadonlyMap<string, DesktopPathState>,
): readonly DesktopPathDifference[] => {
  const differences: DesktopPathDifference[] = [];
  for (const [path, previous] of before) {
    const next = after.get(path);
    if (next === undefined)
      differences.push({
        path,
        kind: "deleted",
        before: previous,
        after: null,
      });
    else if (next.type !== previous.type)
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
  for (const [path, next] of after)
    if (!before.has(path))
      differences.push({ path, kind: "created", before: null, after: next });
  return differences.sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
};

/** Whether a path is one of the roots or lies beneath one. */
export const isWithinAny = (path: string, roots: readonly string[]): boolean =>
  roots.some(
    (root) =>
      path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
