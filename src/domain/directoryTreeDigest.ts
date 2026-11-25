import { createHash } from "node:crypto";
import { z } from "zod";

import { digestSchema } from "./digests.js";

/**
 * The content-addressed identity of a directory tree.
 *
 * Version 1 hashes one canonical byte serialization of every member below the
 * root with SHA-256:
 *
 *     "rea-directory-tree" NUL  u32be(version)  u64be(record count)  record*
 *     record = u8(kind tag)  field(path)  kind-specific fields
 *     field(bytes) = u64be(byte length)  bytes
 *
 * - `path` is the member's path relative to the root: each name's exact
 *   stored bytes, joined by `/`. Names are never Unicode-normalized, so two
 *   names that differ only in normalization are two members. The walker
 *   admits only names that decode as strict UTF-8, which re-encode to the
 *   same bytes; any other name leaves the walk partial. The root itself has
 *   no record.
 * - A regular file adds the 32 raw bytes of its content SHA-256. Mode, owner
 *   and time are not part of the identity.
 * - A directory, including an empty one, adds nothing.
 * - A symlink adds `field(target bytes)` exactly as stored; it is not
 *   followed.
 * - A FIFO, socket or device adds nothing; it is recorded, not read.
 *
 * Records are sorted by the bytes of their path, which for UTF-8 is Unicode
 * code point order. Length-prefixed fields make the encoding injective for any
 * name bytes, and the header binds the algorithm, version and record count.
 * An empty directory is the header with a count of zero.
 */
export const DIRECTORY_TREE_DIGEST_ALGORITHM = "rea-directory-tree";
export const DIRECTORY_TREE_DIGEST_VERSION = 1;

const KIND_TAGS = {
  file: 0x01,
  directory: 0x02,
  symlink: 0x03,
  fifo: 0x04,
  socket: 0x05,
  "block-device": 0x06,
  "character-device": 0x07,
} as const;

/** A member kind the tree digest records. */
export type DirectoryTreeMemberKind = keyof typeof KIND_TAGS;

/** One member of a directory tree, as the digest records it. */
export type DirectoryTreeRecord =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sha256: string;
    }
  | {
      readonly kind: "symlink";
      readonly path: string;
      /** The stored target bytes, hex-encoded. */
      readonly targetHex: string;
    }
  | {
      readonly kind: Exclude<DirectoryTreeMemberKind, "file" | "symlink">;
      readonly path: string;
    };

const algorithmFields = {
  algorithm: z.literal(DIRECTORY_TREE_DIGEST_ALGORITHM),
  version: z.literal(DIRECTORY_TREE_DIGEST_VERSION),
};

/**
 * The root digest of an inventoried directory. Only a walk that examined
 * every member has a digest; a walk that a limit or an unreadable member
 * stopped is partial, names why, and carries no digest.
 */
export const directoryRootDigestSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...algorithmFields,
    status: z.literal("complete"),
    sha256: digestSchema,
    member_count: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    ...algorithmFields,
    status: z.literal("partial"),
    limitations: z.array(z.string().min(1)).min(1),
  }),
]);

/** The root digest of an inventoried directory, complete or partial. */
export type DirectoryRootDigest = z.infer<typeof directoryRootDigestSchema>;

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const u64 = (value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};

const field = (bytes: Buffer): Buffer =>
  Buffer.concat([u64(bytes.length), bytes]);

const HEADER = Buffer.concat([
  Buffer.from(DIRECTORY_TREE_DIGEST_ALGORITHM, "utf8"),
  Buffer.of(0),
]);

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const HEX = /^(?:[a-f0-9]{2})*$/u;

/**
 * The member's exact path bytes. A string that cannot round-trip through
 * UTF-8 (a lone surrogate) or is not a plain relative path is refused rather
 * than encoded lossily.
 */
const memberPathBytes = (path: string): Buffer => {
  const bytes = Buffer.from(path, "utf8");
  if (
    bytes.toString("utf8") !== path ||
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError(
      `Directory tree member path is not an exact relative path: ${JSON.stringify(path)}`,
    );
  return bytes;
};

const encodeRecord = (
  record: DirectoryTreeRecord,
): { readonly path: Buffer; readonly bytes: Buffer } => {
  const path = memberPathBytes(record.path);
  const head = Buffer.concat([Buffer.of(KIND_TAGS[record.kind]), field(path)]);
  if (record.kind === "file") {
    if (!SHA256_HEX.test(record.sha256))
      throw new TypeError("Directory tree file digest is not a SHA-256");
    return {
      path,
      bytes: Buffer.concat([head, Buffer.from(record.sha256, "hex")]),
    };
  }
  if (record.kind === "symlink") {
    if (!HEX.test(record.targetHex))
      throw new TypeError("Directory tree symlink target is not hex");
    return {
      path,
      bytes: Buffer.concat([head, field(Buffer.from(record.targetHex, "hex"))]),
    };
  }
  return { path, bytes: head };
};

/**
 * Hash a complete set of directory members with the version 1 encoding. The
 * input order does not matter; members are sorted canonically first.
 */
export const directoryTreeDigest = (
  records: readonly DirectoryTreeRecord[],
): string => {
  const encoded = records
    .map(encodeRecord)
    .sort(
      (left, right) =>
        Buffer.compare(left.path, right.path) ||
        Buffer.compare(left.bytes, right.bytes),
    );
  const hash = createHash("sha256");
  hash.update(HEADER);
  hash.update(u32(DIRECTORY_TREE_DIGEST_VERSION));
  hash.update(u64(encoded.length));
  for (const { bytes } of encoded) hash.update(bytes);
  return hash.digest("hex");
};

/**
 * Collect members during one walk and report the root digest only when the
 * walk examined every member. A limitation marks the digest partial; a
 * partial digest is never computed, so it cannot stand in for the identity.
 */
export class DirectoryTreeDigestBuilder {
  readonly #records: DirectoryTreeRecord[] = [];
  readonly #limitations = new Set<string>();

  /** Record one examined member. */
  add(record: DirectoryTreeRecord): void {
    this.#records.push(record);
  }

  /** Record why the walk did not examine every member. */
  incomplete(limitation: string): void {
    this.#limitations.add(limitation);
  }

  finish(): DirectoryRootDigest {
    if (this.#limitations.size > 0)
      return {
        algorithm: DIRECTORY_TREE_DIGEST_ALGORITHM,
        version: DIRECTORY_TREE_DIGEST_VERSION,
        status: "partial",
        limitations: [...this.#limitations],
      };
    return {
      algorithm: DIRECTORY_TREE_DIGEST_ALGORITHM,
      version: DIRECTORY_TREE_DIGEST_VERSION,
      status: "complete",
      sha256: directoryTreeDigest(this.#records),
      member_count: this.#records.length,
    };
  }
}
