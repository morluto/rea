/**
 * The one owner of Node's CommonJS entry-point resolution: given a declared
 * package.json `main`-style specifier and a package's member paths, the member
 * Node would load. VSIX extensions and ASAR archives both resolve their `main`
 * through this, so a declared entry resolves identically wherever a package's
 * members are modeled as a path set; each format only normalizes its specifier
 * into that member namespace first.
 */

/**
 * Suffixes Node's loader appends to a declared file entry, in order: the file
 * itself, then its extension siblings.
 */
export const NODE_FILE_CANDIDATES = ["", ".js", ".json", ".node"] as const;

/** Index files Node's loader tries when a declared entry names a directory. */
export const NODE_INDEX_CANDIDATES = [
  "/index.js",
  "/index.json",
  "/index.node",
] as const;

/**
 * The member a declared entry resolves to under a suffix list, or the declared
 * path (with `present: false`) when none matches. Members match exactly, as on
 * a case-sensitive file system; a match that holds only when case is ignored is
 * a separate concern each caller handles for itself.
 */
export const resolveEntryPoint = (
  declared: string,
  suffixes: readonly string[],
  memberPaths: ReadonlySet<string>,
): { readonly path: string; readonly present: boolean } => {
  for (const suffix of suffixes) {
    const candidate = `${declared}${suffix}`;
    if (memberPaths.has(candidate)) return { path: candidate, present: true };
  }
  return { path: declared, present: false };
};

/**
 * Resolve a declared file entry with Node's CommonJS file lookup, then its
 * directory-index fallback: the file itself or an extension sibling, else
 * `<declared>/index.{js,json,node}`. Returns the resolved member, or the
 * declared path with `present: false` when nothing matches.
 */
export const resolveNodeFileEntry = (
  declared: string,
  memberPaths: ReadonlySet<string>,
): { readonly path: string; readonly present: boolean } => {
  const asFile = resolveEntryPoint(declared, NODE_FILE_CANDIDATES, memberPaths);
  return asFile.present
    ? asFile
    : resolveEntryPoint(declared, NODE_INDEX_CANDIDATES, memberPaths);
};

/**
 * Whether a package.json `exports`/`imports` object is a subpath map rather than
 * a conditions object. Node never mixes the two in one object: a subpath map's
 * keys are subpaths beginning with `.` (`"."`, `"./feature"`, `"./*"`), while a
 * conditions object's keys are condition names (`import`, `node`, `default`).
 * The first key settles it. An empty object is neither; it exposes nothing, so
 * treating it as a subpath map (visit its — no — keys) is correct.
 */
export const isSubpathExportsObject = (keys: readonly string[]): boolean =>
  keys[0]?.startsWith(".") ?? true;

/**
 * The condition branches that may still be selected from a conditions object,
 * in declared order. Node resolves a conditions object to the FIRST matching
 * condition in order, and the `default` condition always matches — so no branch
 * after the first `default` can ever be selected. Returns every key through the
 * first `default` (all of them when there is none), so a consumer enumerating
 * reachable targets does not count a branch Node can never reach.
 */
export const selectableConditionKeys = (
  keys: readonly string[],
): readonly string[] => {
  const terminal = keys.indexOf("default");
  return terminal === -1 ? keys : keys.slice(0, terminal + 1);
};

/**
 * Whether a package target is a subpath pattern. Node expands a `*` in an
 * `exports`/`imports` target only against a concrete request, so static
 * analysis cannot resolve it to one member and must leave it unresolved rather
 * than record a literal `*` path that names no file.
 */
export const isWildcardPackageTarget = (target: string): boolean =>
  target.includes("*");
