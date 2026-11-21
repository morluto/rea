import { posix } from "node:path";

/**
 * Set a file URL base far enough below "/" that the URL parser does not
 * discard parent segments. Project the result against two distinct roots:
 * "../source/a.js" can appear to stay below a root made of "source" segments
 * only because its descent spells that root's name. The longer parent prefix
 * from the two projections preserves the actual traversal.
 */
export const createSyntheticUrlRoot = (reference: string) => {
  const depth = reference.split(/[\\/]/u).length + 1;
  const root = `/${"source/".repeat(depth)}`;
  return {
    root,
    relativePath(
      resolvedPath: string,
      resolveAlternative: (root: string) => string | null,
    ): string | null {
      const alternativeRoot = `/${"anchor/".repeat(depth)}`;
      const alternativePath = resolveAlternative(alternativeRoot);
      if (alternativePath === null) return null;
      const primary = posix.relative(root, resolvedPath);
      const alternative = posix.relative(alternativeRoot, alternativePath);
      return parentPrefixLength(alternative) > parentPrefixLength(primary)
        ? alternative
        : primary;
    },
  };
};

const parentPrefixLength = (path: string): number =>
  /^(?:\.\.\/)*(?:\.\.$)?/u.exec(path)?.[0].length ?? 0;
