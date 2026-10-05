import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { parse, parseBinary } from "plist";
import { z } from "zod";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  keyedArchiveInputSchema,
  keyedArchiveResultSchema,
  projectKeyedArchive,
} from "../domain/keyedArchive.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

const MAX_BYTES = 64 * 1024 * 1024;

/** Parse inert plist bytes, preserving data and dates with explicit typed values. */
export const decodeKeyedArchiveBytes = (
  bytes: Buffer,
  selection: { root?: string | undefined; offset: number; limit: number },
) => {
  if (bytes.length > MAX_BYTES)
    throw new RangeError("Keyed archive exceeds 64 MiB");
  const binary = bytes.subarray(0, 8).toString("ascii") === "bplist00";
  const parsed: unknown = binary
    ? parseBinary(bytes)
    : parse(decodeXmlPlistText(bytes));
  return {
    archive_format: binary ? ("binary-plist" as const) : ("xml-plist" as const),
    ...projectKeyedArchive(normalizePlist(parsed), selection),
  };
};

const decodeXmlPlistText = (bytes: Buffer): string => {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/u
    .exec(text)?.[1]
    ?.toLowerCase();
  if (
    declared !== undefined &&
    ((encoding !== "utf-8" && declared !== encoding && declared !== "utf-16") ||
      (encoding === "utf-8" && declared.startsWith("utf-16")))
  )
    throw new TypeError("XML encoding declaration disagrees with its bytes");
  return text;
};

const normalizePlist = (value: unknown, depth = 0): JsonValue => {
  if (depth > 128) throw new RangeError("Plist exceeds 128 nesting levels");
  if (value instanceof Uint8Array)
    return {
      $plist_type: "data",
      base64: Buffer.from(value).toString("base64"),
    };
  if (value instanceof Date)
    return { $plist_type: "date", iso8601: value.toISOString() };
  if (Array.isArray(value))
    return value.map((item: unknown) => normalizePlist(item, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizePlist(item, depth + 1),
      ]),
    );
  return z
    .union([z.string(), z.number().finite(), z.boolean(), z.null()])
    .parse(value);
};

/** Read exactly one regular, contained bundle entry without following symlinks. */
export const inspectBundleKeyedArchive = async (input: {
  bundlePath: string;
  targetSha256: string;
  parameters: unknown;
  signal?: AbortSignal;
}) => {
  const selected = keyedArchiveInputSchema.parse(input.parameters);
  if (
    selected.path.startsWith("/") ||
    selected.path
      .split("/")
      .some((part) => part === ".." || part === "." || part.length === 0)
  )
    throw new ArtifactReaderFailure(
      "path",
      "Archive path must be a canonical relative bundle path",
    );
  const reader = new DirectoryArtifactReader(input.bundlePath);
  try {
    for await (const entry of reader.entries(input.signal)) {
      if (entry.path !== selected.path) continue;
      if (entry.kind !== "file")
        throw new ArtifactReaderFailure(
          "path",
          "Archive must be a regular file, not a symlink or directory",
        );
      if ((entry.declaredSize ?? 0) > MAX_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          "Keyed archive exceeds 64 MiB",
        );
      const stream = await reader.open(entry, input.signal);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        if (input.signal?.aborted) {
          stream.destroy();
          throw new ArtifactReaderFailure(
            "cancelled",
            "Archive inspection cancelled",
          );
        }
        const bytes = z.instanceof(Buffer).parse(chunk);
        size += bytes.length;
        if (size > MAX_BYTES) {
          stream.destroy();
          throw new ArtifactReaderFailure(
            "limit",
            "Keyed archive exceeds 64 MiB",
          );
        }
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, size);
      try {
        return keyedArchiveResultSchema.parse({
          target_sha256: input.targetSha256,
          archive_path: entry.path,
          archive_sha256: createHash("sha256").update(bytes).digest("hex"),
          ...decodeKeyedArchiveBytes(bytes, selected),
        });
      } catch (cause) {
        throw new ArtifactReaderFailure(
          cause instanceof RangeError ? "limit" : "format",
          "Cannot decode selected Foundation keyed archive",
          { cause },
        );
      }
    }
    throw new ArtifactReaderFailure(
      "path",
      `Archive not found in bundle: ${selected.path}`,
    );
  } finally {
    await reader.close();
  }
};
