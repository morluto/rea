import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { parseBinary } from "plist";
import { z } from "zod";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { projectPlistValue } from "../../domain/apple/plistValue.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../../domain/propertyListKeys.js";
import {
  keyedArchiveInputSchema,
  keyedArchiveResultSchema,
  projectKeyedArchive,
} from "../../domain/apple/keyedArchive.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";

const MAX_BYTES = 64 * 1024 * 1024;

/** Parse inert plist bytes, preserving data and dates with explicit typed values. */
export const decodeKeyedArchiveBytes = (
  bytes: Buffer,
  selection: { root?: string | undefined; offset: number; limit: number },
) => {
  if (bytes.length > MAX_BYTES)
    throw new RangeError("Keyed archive exceeds 64 MiB");
  if (bytes.subarray(0, 10).toString("ascii") === "NIBArchive")
    throw new TypeError(
      "Selected file is a compiled NIBArchive, not a Foundation plist archive; decode it with decode_interface_builder",
    );
  const binary = bytes.subarray(0, 8).toString("ascii") === "bplist00";
  const parsed = binary
    ? { value: parseBinary(bytes), omittedPrototypeKeys: 0 }
    : parseXmlPropertyList(decodeXmlPlistText(bytes));
  const graph = projectKeyedArchive(normalizePlist(parsed.value), selection);
  return {
    archive_format: binary ? ("binary-plist" as const) : ("xml-plist" as const),
    ...graph,
    limitations: [
      ...graph.limitations,
      ...(parsed.omittedPrototypeKeys === 0
        ? []
        : [omittedPrototypeKeysLimitation(parsed.omittedPrototypeKeys)]),
    ],
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

const normalizePlist = (value: unknown): JsonValue => {
  const projected = projectPlistValue(value);
  if (projected.unknownRealCount > 0)
    throw new RangeError("Keyed archive contains a non-finite real");
  return projected.value;
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
    throw archivePathError(
      "invalid_format",
      selected.path === "."
        ? "Select a keyed archive path relative to the active app bundle."
        : `Archive path must be a canonical relative bundle path without empty, '.', or '..' segments: ${selected.path}`,
    );
  const reader = new DirectoryArtifactReader(input.bundlePath);
  try {
    for await (const entry of reader.entries(input.signal)) {
      if (entry.path !== selected.path) continue;
      if (entry.kind !== "file")
        throw archivePathError(
          "invalid_value",
          `Archive path selects a ${entry.kind}, not a regular file: ${selected.path}`,
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
        if (cause instanceof AnalysisInputError) throw cause;
        throw new ArtifactReaderFailure(
          cause instanceof RangeError ? "limit" : "format",
          `Cannot decode selected Foundation keyed archive: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }
    throw archivePathError(
      "invalid_value",
      `No regular file exists at ${selected.path} in the active app bundle.`,
    );
  } finally {
    await reader.close();
  }
};

/** A caller-selected archive path, not the artifact, failed its constraint. */
const archivePathError = (
  reason: "invalid_format" | "invalid_value",
  message: string,
) =>
  new AnalysisInputError("inspect_keyed_archive", undefined, [
    { path: ["path"], reason, message },
  ]);
