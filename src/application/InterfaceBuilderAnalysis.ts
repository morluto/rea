import { createHash } from "node:crypto";
import { parse, parseBinary } from "plist";

import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
  type InterfaceBuilderDocumentInput,
} from "../domain/interfaceBuilderGraph.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** Decode compiled Interface Builder plist archives from a local app bundle. */
export const analyzeInterfaceBuilderBundle = async (input: {
  readonly bundlePath: string;
  readonly targetSha256: string;
  readonly limits?: unknown;
  readonly signal?: AbortSignal;
}) => {
  const limits = interfaceBuilderLimitsSchema.parse(input.limits ?? {});
  const reader = new DirectoryArtifactReader(input.bundlePath);
  const documents: InterfaceBuilderDocumentInput[] = [];
  const invalid: string[] = [];
  let omitted = 0;
  try {
    for await (const entry of reader.entries(input.signal)) {
      if (entry.kind !== "file" || !isInterfaceBuilderArchive(entry.path))
        continue;
      if (documents.length >= limits.max_documents) {
        omitted += 1;
        continue;
      }
      try {
        const bytes = await readEntry(reader, entry, input.signal);
        const raw = decodePlist(bytes);
        const documentHash = createHash("sha256").update(bytes).digest("hex");
        documents.push({
          relativePath: entry.path,
          archiveSha256: documentHash,
          documentKind: entry.path.includes(".storyboardc/")
            ? "storyboard_scene"
            : "nib",
          raw,
        });
      } catch (cause: unknown) {
        if (input.signal?.aborted === true) throw cause;
        invalid.push(
          `${entry.path}: ${cause instanceof Error ? cause.message : "archive decode failed"}`,
        );
      }
    }
  } finally {
    await reader.close();
  }
  const result = buildInterfaceBuilderAnalysis({
    targetSha256: input.targetSha256,
    toolVersion: "rea-interface-builder/1",
    documents,
    limits,
  });
  return {
    ...result,
    graph: {
      ...result.graph,
      coverage: [
        ...result.graph.coverage,
        {
          facet: "archive_decode",
          status: invalid.length > 0 ? "partial" as const : "complete" as const,
          reason: invalid.length > 0 ? "one_or_more_archives_invalid" : null,
          examined: documents.length,
          omitted: invalid.length + omitted,
        },
      ],
      truncated: result.graph.truncated || omitted > 0 || invalid.length > 0,
    },
    limitations: [
      ...result.limitations,
      "Compiled Interface Builder archives are private serialized object graphs. The decoder reports only recognized keyed-archive objects and connections; unrecognized object classes and fields remain unknown.",
      ...(invalid.length === 0 ? [] : [`Some Interface Builder archives could not be decoded: ${invalid.slice(0, 16).join("; ")}`]),
    ],
  };
};

const isInterfaceBuilderArchive = (path: string): boolean => {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".nib") ||
    lower.endsWith("/objects.nib")
  );
};

const readEntry = async (
  reader: DirectoryArtifactReader,
  entry: ArtifactEntry,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (entry.declaredSize !== null && entry.declaredSize > MAX_DOCUMENT_BYTES)
    throw new RangeError("archive exceeds the 64 MiB per-document decode limit");
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > MAX_DOCUMENT_BYTES) {
      stream.destroy();
      throw new RangeError("archive exceeded the 64 MiB per-document decode limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
};

const decodePlist = (bytes: Buffer): JsonValue => {
  const parsed = bytes.subarray(0, 8).toString("ascii") === "bplist00"
    ? parseBinary(bytes)
    : parse(bytes.toString("utf8"));
  return jsonValueSchema.parse(parsed);
};
