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
