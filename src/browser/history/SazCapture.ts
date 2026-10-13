import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../../artifacts/ArtifactReader.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../../domain/webNetworkCapture.js";
import { SAZ_CAPTURE_PROVIDER_IDENTITY } from "./CaptureRelease.js";
import { CaptureFormatError } from "./CaptureFormatError.js";
import { decodeSazHttp } from "./SazHttp.js";
import { decodeSazMetadata } from "./SazMetadata.js";
import { projectSazRecord, type SazValue } from "./SazProjection.js";

/** Decode native SAZ sessions without extracting files, running Fiddler or converting to HAR. */
export const decodeSazCapture = async (
  snapshotPath: string,
  sensitiveValues: readonly string[],
) => {
  const reader = new ZipArtifactReader(
    snapshotPath,
    "zip",
    WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
  );
  try {
    const groups = new Map<string, ArtifactEntry[]>();
    const inventory: SazValue[] = [];
    const paths = new Set<string>();
    let declaredBytes = 0;
    for await (const entry of reader.entries()) {
      if (paths.has(entry.path))
        throw new CaptureFormatError(
          "format",
          "SAZ contains duplicate archive member names.",
        );
      paths.add(entry.path);
      if (entry.encrypted)
        throw new CaptureFormatError(
          "unsupported",
          "Encrypted SAZ archives are unsupported; export an unencrypted copy from Fiddler Everywhere.",
        );
      if (entry.kind !== "file" && entry.kind !== "directory")
        throw new CaptureFormatError(
          "unsupported",
          "SAZ archive links are unsupported.",
        );
      if (entry.declaredSize !== null) {
        if (!Number.isSafeInteger(entry.declaredSize) || entry.declaredSize < 0)
          throw new CaptureFormatError("format", "SAZ member size is invalid.");
        declaredBytes += entry.declaredSize;
      }
      if (declaredBytes > WEB_NETWORK_CAPTURE_LIMITS.inputBytes)
        throw new CaptureFormatError(
          "limit",
          "SAZ expanded members exceed the 32 MiB complete-evidence budget.",
        );
      inventory.push({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.declaredSize,
      });
      if (entry.kind !== "file") continue;
      const match = /^raw\/(\d+)_(c\.txt|s\.txt|m\.xml|w\.txt|g\.txt)$/.exec(
        entry.path,
      );
      if (match?.[1] !== undefined) {
        const group = groups.get(match[1]) ?? [];
        group.push(entry);
        groups.set(match[1], group);
      } else if (entry.path.startsWith("raw/")) {
        throw new CaptureFormatError(
          "unsupported",
          "SAZ contains an unrecognized raw session member.",
        );
      }
    }
    if (groups.size === 0)
      throw new CaptureFormatError(
        "format",
        "Archive contains no SAZ session members.",
      );
    const records: WebNetworkCaptureRecord[] = [];
    for (const [session_id, entries] of groups) {
      const source: Record<string, SazValue> = {
        session_id,
        request: null,
        response: null,
        metadata: null,
        websocket: null,
        grpc: null,
      };
      for (const entry of entries) {
        const stream = await reader.open(entry);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk))
            throw new CaptureFormatError(
              "format",
              "SAZ member stream returned non-byte data.",
            );
          length += chunk.length;
          if (length > (entry.declaredSize ?? 0))
            throw new CaptureFormatError(
              "format",
              "SAZ member exceeds its declared size.",
            );
          chunks.push(chunk);
        }
        if (length !== entry.declaredSize)
          throw new CaptureFormatError(
            "format",
            "SAZ member does not match its declared size.",
          );
        const bytes = Buffer.concat(chunks, length);
        if (entry.path.endsWith("_c.txt"))
          source.request = {
            member: entry.path,
            ...decodeSazHttp(bytes, true),
          };
        else if (entry.path.endsWith("_s.txt"))
          source.response = {
            member: entry.path,
            ...decodeSazHttp(bytes, false),
          };
        else if (entry.path.endsWith("_m.xml"))
          source.metadata = {
            member: entry.path,
            document: decodeSazMetadata(bytes),
          };
        else
          source[entry.path.endsWith("_w.txt") ? "websocket" : "grpc"] = {
            member: entry.path,
            messages: bytes,
          };
      }
      records.push({
        ordinal: records.length,
        location: {
          kind: "archive-members",
          members: entries.map((entry) => entry.path),
        },
        ...projectSazRecord(source, sensitiveValues),
        limitations: [],
      });
    }
    const container = projectSazRecord({ members: inventory }, sensitiveValues);
    return {
      decoder: { ...SAZ_CAPTURE_PROVIDER_IDENTITY },
      container: {
        reported: container.reported,
        numeric_literals: container.numeric_literals,
        redactions: container.redactions,
        records_pointer: null,
      },
      total_records: records.length,
      records,
    };
  } catch (cause: unknown) {
    if (cause instanceof CaptureFormatError) throw cause;
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      throw new CaptureFormatError(
        "limit",
        "SAZ archive exceeds the ZIP reader's resource budget.",
      );
    throw new CaptureFormatError(
      "format",
      "SAZ archive or session data is malformed or fails ZIP integrity validation.",
    );
  } finally {
    await reader.close();
  }
};
