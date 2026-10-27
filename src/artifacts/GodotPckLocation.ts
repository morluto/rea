import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import {
  hasGodotPckHeader,
  readGodotPckTrailerFacts,
  type GodotPckTrailerFacts,
} from "../domain/godotPckFormat.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";

export interface GodotPckLocation {
  readonly start: number;
  readonly end: number;
  readonly embedded: boolean;
}

/** Located pack facts borrowed with the descriptor that produced them. */
export interface GodotPckAdmission {
  readonly kind: "godot-pck";
  readonly source: StableRegularFileDescriptor;
  readonly location: GodotPckLocation;
}

type DeclaredGodotPckTrailer = Extract<
  GodotPckTrailerFacts,
  { readonly state: "declared" }
>;

/** A malformed declaration remains distinct from an examined missing marker. */
export type EmbeddedGodotPckObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "invalid-extent" | "header-mismatch";
      readonly declaration: DeclaredGodotPckTrailer;
    }
  | {
      readonly state: "located";
      readonly declaration: DeclaredGodotPckTrailer;
      readonly start: number;
      readonly header: Buffer;
    };

/**
 * Observe an admitted source of at least 12 bytes. Caller-owned exact reads retain
 * admission, cancellation, budgets and range evidence; read failures propagate.
 */
export const observeEmbeddedGodotPck = async (
  size: number,
  headerBytes: 4 | 20,
  read: (offset: number, bytes: number, end: number) => Promise<Buffer>,
): Promise<EmbeddedGodotPckObservation> => {
  const trailer = await read(size - 12, 12, size);
  const declaration = readGodotPckTrailerFacts(trailer, size);
  if (declaration.state === "absent") return declaration;
  const { start, end, packBytes } = declaration;
  if (start === null || packBytes < BigInt(headerBytes))
    return { state: "invalid-extent", declaration };
  const header = await read(start, headerBytes, end);
  if (!hasGodotPckHeader(header))
    return { state: "header-mismatch", declaration };
  return { state: "located", declaration, start, header };
};

/** Positional exact reads preserve short-read, cancellation and I/O semantics. */
export const readPckBytes = async (
  handle: Pick<FileHandle, "read">,
  position: number,
  length: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position < 0 ||
    length > end - position
  )
    throw new ArtifactReaderFailure(
      "format",
      "Godot PCK read exceeds its source range",
    );
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    assertArtifactReadActive(signal);
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      length - consumed,
      position + consumed,
    );
    assertArtifactReadActive(signal);
    if (bytesRead === 0)
      throw new ArtifactReaderFailure(
        "format",
        "Godot PCK source is truncated",
      );
    consumed += bytesRead;
  }
  return buffer;
};

/** Recognize a standalone header or the exact engine trailer; never scan payloads. */
export const locateGodotPck = async (
  handle: Pick<FileHandle, "read">,
  size: number,
  signal?: AbortSignal,
  prefix?: Uint8Array,
): Promise<GodotPckLocation | undefined> => {
  assertArtifactReadActive(signal);
  if (!Number.isSafeInteger(size) || size < 4) return undefined;
  const magic =
    prefix !== undefined && prefix.length >= 4
      ? Buffer.from(prefix.buffer, prefix.byteOffset, 4)
      : await readPckBytes(handle, 0, 4, size, signal);
  if (hasGodotPckHeader(magic)) return { start: 0, end: size, embedded: false };
  if (size < 12) return undefined;
  const observation = await observeEmbeddedGodotPck(
    size,
    4,
    (offset, bytes, end) => readPckBytes(handle, offset, bytes, end, signal),
  );
  if (observation.state !== "located") return undefined;
  return {
    start: observation.start,
    end: observation.declaration.end,
    embedded: true,
  };
};
