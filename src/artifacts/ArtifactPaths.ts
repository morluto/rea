import { posix } from "node:path";

import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

const DRIVE_OR_UNC = /^(?:[A-Za-z]:|\\|\/\/)/u;

/**
 * English Unicode case folding used only to describe logical names a
 * case-insensitive destination might collapse. It is not a filesystem case table.
 */
const ENGLISH_UNICODE_CASE_NOTE =
  "This comparison is not a filesystem observation.";

/** Inventory limitation when logical names collide under English Unicode case folding. */
export const ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION = `Logical archive names collide under English (en-US) Unicode case folding; a case-insensitive destination cannot store both spellings. ${ENGLISH_UNICODE_CASE_NOTE}`;

/** User-facing prefix for a destination that cannot keep two logical spellings. */
export const DESTINATION_CASE_COLLISION_PREFIX =
  "Destination filesystem cannot store both ";

/** Normalize an untrusted logical archive path without touching filesystem. */
export const normalizeArtifactPath = (input: string): string => {
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    DRIVE_OR_UNC.test(input)
  )
    throw new ArtifactReaderFailure(
      "path",
      `Artifact path is absolute or unsafe: ${JSON.stringify(input)}`,
    );
  const normalized = input.normalize("NFC").replace(/\/+$/u, "");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(normalized) !== normalized
  )
    throw new ArtifactReaderFailure(
      "path",
      `Artifact path is not normalized: ${JSON.stringify(input)}`,
    );
  return normalized;
};

/** Reject exact and same-spelling prefix collisions. Case-distinct names stay distinct. */
export class ArtifactPathRegistry {
  readonly #root: PathTrieNode = { kind: undefined, children: new Map() };

  add(path: string, kind: "file" | "directory" | "symlink" | "slice"): void {
    const parts = path.split("/");
    let node = this.#root;
    for (const [index, part] of parts.entries()) {
      if (node.kind !== undefined && node.kind !== "directory")
        throw new ArtifactReaderFailure(
          "path",
          `Artifact prefix conflict: ${path}`,
        );
      let child = node.children.get(part);
      if (child === undefined) {
        child = { kind: undefined, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
      if (index === parts.length - 1) {
        if (node.kind !== undefined)
          throw new ArtifactReaderFailure(
            "path",
            `Artifact path collision: ${path}`,
          );
        if (kind !== "directory" && node.children.size > 0)
          throw new ArtifactReaderFailure(
            "path",
            `Artifact prefix conflict: ${path}`,
          );
      }
    }
    node.kind = kind;
  }
}

interface PathTrieNode {
  kind: "file" | "directory" | "symlink" | "slice" | undefined;
  readonly children: Map<string, PathTrieNode>;
}

interface CaseNode {
  readonly bySpelling: Map<string, CaseNode>;
  readonly spellingsByFold: Map<string, string[]>;
  readonly terminals: string[];
}

const emptyCaseNode = (): CaseNode => ({
  bySpelling: new Map(),
  spellingsByFold: new Map(),
  terminals: [],
});

const englishCaseFold = (part: string): string =>
  part.toLocaleLowerCase("en-US");

/**
 * Record English (en-US) Unicode case collisions on each affected occurrence.
 * Returns the inventory limitation when any logical names collide.
 */
export const annotateEnglishUnicodeCaseCollisions = (
  occurrences: readonly {
    readonly logical_path: string;
    limitations: string[];
  }[],
): string | undefined => {
  const collisions = englishUnicodeCaseCollisions(
    occurrences.map(({ logical_path }) => logical_path),
  );
  if (collisions.size === 0) return undefined;
  for (const occurrence of occurrences) {
    const others = collisions.get(occurrence.logical_path);
    if (others === undefined || others.length === 0) continue;
    occurrence.limitations.push(
      `Logical path ${occurrence.logical_path} collides under English (en-US) Unicode case folding with ${others.join(", ")}; a case-insensitive destination cannot store both. ${ENGLISH_UNICODE_CASE_NOTE}`,
    );
  }
  return ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION;
};

/**
 * Name the directory-listing spelling that differs from the requested segment
 * only by English (en-US) Unicode case. Exact matches are the same logical name.
 */
export const destinationCaseCollisionMessage = (
  requestedPath: string,
  existingNames: readonly string[],
): string | undefined => {
  const slash = requestedPath.lastIndexOf("/");
  const segment = slash < 0 ? requestedPath : requestedPath.slice(slash + 1);
  if (existingNames.includes(segment)) return undefined;
  const folded = englishCaseFold(segment);
  const existing = existingNames
    .filter((name) => englishCaseFold(name) === folded)
    .sort(compareUnicodeCodePoints)[0];
  if (existing === undefined) return undefined;
  const parent = slash < 0 ? "" : requestedPath.slice(0, slash + 1);
  return `${DESTINATION_CASE_COLLISION_PREFIX}${requestedPath} and ${parent}${existing}; inventory retains both logical names.`;
};

const englishUnicodeCaseCollisions = (
  paths: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const root = emptyCaseNode();
  for (const path of paths) {
    if (path.length === 0 || path === ".") continue;
    let node = root;
    for (const part of path.split("/")) {
      const folded = englishCaseFold(part);
      const spellings = node.spellingsByFold.get(folded);
      if (spellings === undefined) node.spellingsByFold.set(folded, [part]);
      else if (!spellings.includes(part)) spellings.push(part);
      let child = node.bySpelling.get(part);
      if (child === undefined) {
        child = emptyCaseNode();
        node.bySpelling.set(part, child);
      }
      node = child;
    }
    node.terminals.push(path);
  }
  const collisions = new Map<string, Set<string>>();
  recordCaseCollisions(root, collisions);
  return new Map(
    [...collisions.entries()].map(([path, others]) => [
      path,
      [...others].sort(compareUnicodeCodePoints),
    ]),
  );
};

const recordCaseCollisions = (
  node: CaseNode,
  collisions: Map<string, Set<string>>,
): void => {
  for (const spellings of node.spellingsByFold.values())
    if (spellings.length > 1) noteFoldedSpellings(node, spellings, collisions);
  for (const child of node.bySpelling.values())
    recordCaseCollisions(child, collisions);
};

const noteFoldedSpellings = (
  node: CaseNode,
  spellings: readonly string[],
  collisions: Map<string, Set<string>>,
): void => {
  const groups = spellings.map((spelling) => {
    const child = node.bySpelling.get(spelling);
    return child === undefined ? [] : terminalsUnder(child);
  });
  for (const [index, group] of groups.entries())
    noteCaseGroup(
      group,
      groups.flatMap((candidate, candidateIndex) =>
        candidateIndex === index ? [] : candidate,
      ),
      collisions,
    );
};

const noteCaseGroup = (
  group: readonly string[],
  others: readonly string[],
  collisions: Map<string, Set<string>>,
): void => {
  for (const path of group) {
    const set = collisions.get(path) ?? new Set<string>();
    for (const other of others) if (other !== path) set.add(other);
    collisions.set(path, set);
  }
};

const terminalsUnder = (node: CaseNode): readonly string[] => {
  const paths = [...node.terminals];
  for (const child of node.bySpelling.values())
    paths.push(...terminalsUnder(child));
  return paths;
};
