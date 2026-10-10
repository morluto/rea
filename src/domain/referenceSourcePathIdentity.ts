export interface ReferenceSourcePathLookup {
  readonly resolve: (path: string) => string | undefined;
  readonly resolveCandidates: (paths: readonly string[]) => string | undefined;
}

/**
 * Reference inventories retain filesystem spelling. Prefer that exact identity;
 * canonical Unicode equivalence is a fallback only when it identifies one entry.
 */
export const createReferenceSourcePathLookup = (
  paths: Iterable<string>,
): ReferenceSourcePathLookup => {
  const exact = new Set(paths);
  const canonical = new Map<string, string | null>();
  for (const path of exact) {
    const key = path.normalize("NFC");
    canonical.set(key, canonical.has(key) ? null : path);
  }
  const equivalent = (path: string): string | undefined =>
    canonical.get(path.normalize("NFC")) ?? undefined;
  return {
    resolve: (path) => (exact.has(path) ? path : equivalent(path)),
    resolveCandidates: (candidates) =>
      candidates.find((path) => exact.has(path)) ??
      candidates.map(equivalent).find((path) => path !== undefined),
  };
};

/** Symlink evidence can originate on a different OS from the graph reader. */
export const isPortableAbsoluteReferenceTarget = (target: string): boolean =>
  target.startsWith("/") ||
  /^[A-Za-z]:[\\/]/u.test(target) ||
  /^\\\\[^\\/]+[\\/][^\\/]+/u.test(target);
