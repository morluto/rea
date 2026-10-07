import { posix } from "node:path";

import { ArtifactReaderFailure } from "./ArtifactReader.js";

const DRIVE_OR_UNC = /^(?:[A-Za-z]:|\\|\/\/)/u;

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

/** Reject exact, Unicode-normalized, case-folded, and prefix collisions. */
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
      const foldedPart = part.toLocaleLowerCase("en-US");
      let child = node.children.get(foldedPart);
      if (child !== undefined && child.spelling !== part)
        throw new ArtifactReaderFailure(
          "path",
          `Artifact path collision: ${path} differs only in case from ${[...parts.slice(0, index), child.spelling].join("/")}`,
        );
      if (child === undefined) {
        child = { spelling: part, kind: undefined, children: new Map() };
        node.children.set(foldedPart, child);
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
  readonly spelling?: string;
  kind: "file" | "directory" | "symlink" | "slice" | undefined;
  readonly children: Map<string, PathTrieNode>;
}
