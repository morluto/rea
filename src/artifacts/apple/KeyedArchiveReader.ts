import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseBinary } from "plist";
import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { projectPlistValue } from "../../domain/apple/plistValue.js";
import { createPlistNumberProjection } from "../../domain/apple/plistNumbers.js";
import {
  binaryPlistNumberLiterals,
  xmlPlistNumberLiterals,
} from "./PlistNumberLiterals.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../../domain/propertyListKeys.js";
import {
  KeyedArchiveKindError,
  keyedArchiveInputSchema,
  keyedArchiveResultSchema,
  projectKeyedArchive,
} from "../../domain/apple/keyedArchive.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { ArtifactEntry } from "../ArtifactReader.js";

import { decodeXmlPlistText } from "../../domain/propertyListXmlText.js";

const MAX_BYTES = 64 * 1024 * 1024;

/** Parse inert plist bytes, preserving data and dates with explicit typed values. */
export const decodeKeyedArchiveBytes = (
  bytes: Buffer,
  selection: { root?: string | undefined; offset: number; limit: number },
) => {
  if (bytes.length > MAX_BYTES)
    throw new RangeError("Keyed archive exceeds 64 MiB");
  if (bytes.subarray(0, 10).toString("ascii") === "NIBArchive")
    throw new KeyedArchiveKindError(
      "Selected file is a compiled NIBArchive, not a Foundation plist archive; decode it with decode_interface_builder",
      "nib-archive",
    );
  const binary = bytes.subarray(0, 8).toString("ascii") === "bplist00";
  const xmlText = binary ? undefined : decodeXmlPlistText(bytes);
  const parsed = binary
    ? { value: parseBinary(bytes), omittedPrototypeKeys: 0 }
    : parseXmlPropertyList(xmlText ?? "");
  const { value: plistValue, unknownRealCount } = projectPlistValue(
    parsed.value,
  );
  const graph = projectKeyedArchive(plistValue, selection);
  const numbers = createPlistNumberProjection(
    binary
      ? binaryPlistNumberLiterals(bytes)
      : xmlPlistNumberLiterals(xmlText ?? ""),
  );
  // Classify the serialized graph before projecting values to typed decimals.
  // Numeric IDs, node kinds, references and pagination retain their original meaning.
  const roots = Object.fromEntries(
    Object.entries(graph.roots).map(([name, value]) => [
      name,
      numbers.project(value),
    ]),
  );
  const objects = graph.objects.map((object) => ({
    ...object,
    value: numbers.project(object.value),
  }));
  return {
    archive_format: binary ? ("binary-plist" as const) : ("xml-plist" as const),
    ...graph,
    roots,
    objects,
    limitations: [
      ...graph.limitations,
      ...numbers.limitations(),
      ...(parsed.omittedPrototypeKeys === 0
        ? []
        : [omittedPrototypeKeysLimitation(parsed.omittedPrototypeKeys)]),
      ...(unknownRealCount === 0
        ? []
        : [
            `${String(unknownRealCount)} non-finite real value(s) are reported as { "$plist_type": "real", "value": null } because JSON evidence cannot preserve NaN vs infinity.`,
          ]),
    ],
  };
};

/**
 * Point to the workflow that reads the selected kind of file on this host.
 * decode_interface_builder is portable; inspect_plist requires macOS.
 */
const keyedArchiveKindRemediation = (
  kind: KeyedArchiveKindError["kind"],
  platform: NodeJS.Platform,
): string => {
  if (kind === "nib-archive")
    return "Decode compiled NIBArchive files with decode_interface_builder on the app bundle.";
  return platform === "darwin"
    ? "Inspect an ordinary property list with inspect_plist; inspect_keyed_archive decodes NSKeyedArchiver archives only."
    : "Select an NSKeyedArchiver archive; inspect_keyed_archive decodes only those. inspect_plist, which reads ordinary property lists, requires a macOS host.";
};

/** Read exactly one regular, contained bundle entry without following symlinks. */
export const inspectBundleKeyedArchive = async (input: {
  bundlePath: string;
  targetSha256: string;
  parameters: unknown;
  signal?: AbortSignal;
  /** Host whose available workflows the remediation names. */
  platform?: NodeJS.Platform;
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
    // Match inventory spelling while retaining the raw path for I/O and evidence.
    const wanted = selected.path.normalize("NFC");
    const matches: ArtifactEntry[] = [];
    for await (const entry of reader.entries(input.signal)) {
      if (entry.path.normalize("NFC") !== wanted) continue;
      matches.push(entry);
    }
    if (matches.length > 1)
      throw archivePathError(
        "invalid_value",
        `Archive path matches ${String(matches.length)} Unicode-equivalent bundle entries; selection is ambiguous: ${selected.path}`,
      );
    const entry = matches[0];
    if (entry === undefined)
      throw archivePathError(
        "invalid_value",
        `No regular file exists at ${selected.path} in the active app bundle.`,
      );
    if (entry.kind !== "file")
      throw archivePathError(
        "invalid_value",
        `Archive path selects a ${entry.kind}, not a regular file: ${selected.path}`,
      );
    if ((entry.declaredSize ?? 0) > MAX_BYTES)
      throw new ArtifactReaderFailure("limit", "Keyed archive exceeds 64 MiB");
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
      // An intact file of another kind is not a damaged archive.
      if (cause instanceof KeyedArchiveKindError)
        throw new AnalysisUnsupportedTargetError(
          "inspect_keyed_archive",
          join(input.bundlePath, entry.path),
          cause.message,
          {
            cause,
            remediationAction: keyedArchiveKindRemediation(
              cause.kind,
              input.platform ?? process.platform,
            ),
          },
        );
      throw new ArtifactReaderFailure(
        cause instanceof RangeError ? "limit" : "format",
        `Cannot decode selected Foundation keyed archive: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
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
