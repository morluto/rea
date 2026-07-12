import { Buffer } from "node:buffer";
import { posix } from "node:path";

import {
  ArtifactReaderFailure,
  type ArtifactLimits,
} from "./ArtifactReader.js";

const DRIVE_OR_UNC = /^(?:[A-Za-z]:|\\|\/\/)/u;

/** Normalize an untrusted logical archive path without touching filesystem. */
export const normalizeArtifactPath = (
  input: string,
  limits: Pick<ArtifactLimits, "maxDepth" | "maxPathBytes">,
): string => {
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    DRIVE_OR_UNC.test(input)
  )
    throw new ArtifactReaderFailure(
      "path",
      "Artifact path is absolute or unsafe",
    );
  const normalized = input.normalize("NFC").replace(/\/+$/u, "");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    parts.length > limits.maxDepth ||
    Buffer.byteLength(normalized, "utf8") > limits.maxPathBytes ||
    posix.normalize(normalized) !== normalized
  )
    throw new ArtifactReaderFailure("path", "Artifact path is not normalized");
  return normalized;
};

/** Reject exact, Unicode-normalized, case-folded, and prefix collisions. */
export class ArtifactPathRegistry {
  readonly #root: PathTrieNode = { kind: undefined, children: new Map() };
  readonly #folded = new Set<string>();

  add(path: string, kind: "file" | "directory" | "symlink" | "slice"): void {
    const folded = path.toLocaleLowerCase("en-US");
    if (this.#folded.has(folded))
      throw new ArtifactReaderFailure(
        "path",
        `Artifact path collision: ${path}`,
      );
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
    this.#folded.add(folded);
  }
}

interface PathTrieNode {
  kind: "file" | "directory" | "symlink" | "slice" | undefined;
  readonly children: Map<string, PathTrieNode>;
}
