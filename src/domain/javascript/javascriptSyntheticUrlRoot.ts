import { posix } from "node:path";

/**
 * Relative URL references are resolved below a deep synthetic root so their
 * leading `..` segments survive instead of clamping at `/`. A reference can
 * leave that root and re-enter it by naming one of its segments: below
 * `/source/source/`, `../source/x.js` resolves to `/source/source/x.js` and
 * its parent segment is lost. One reference cannot spell two different root
 * names at the same positions, so resolve below both and keep the result
 * that retains more parent segments.
 */
const ROOT_SEGMENT_NAMES = ["source", "anchor"] as const;

/**
 * Resolve below synthetic roots deep enough for `depth` parent segments and
 * return the decoded path relative to the root, or null when `resolve`
 * declines. `resolve` receives an absolute POSIX root ending in `/`.
 */
export const pathBelowSyntheticUrlRoot = (
  depth: number,
  resolve: (root: string) => string | null,
): string | null => {
  let kept: string | null = null;
  for (const name of ROOT_SEGMENT_NAMES) {
    const root = `/${`${name}/`.repeat(depth)}`;
    const path = resolve(root);
    if (path === null) return null;
    const relative = posix.relative(root, path);
    if (
      kept === null ||
      leadingParentSegments(relative) > leadingParentSegments(kept)
    )
      kept = relative;
  }
  return kept;
};

const leadingParentSegments = (path: string): number => {
  let count = 0;
  for (const segment of path.split("/")) {
    if (segment !== "..") break;
    count += 1;
  }
  return count;
};
