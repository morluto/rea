import { hasElfMagic } from "../domain/binaryContainer.js";
import { observeMzWindowsHeader } from "../domain/dosMz.js";
import {
  unsupportedInput,
  ParseFailureError,
  type LimitRef,
} from "../domain/parseFailure.js";
import { readPeCoffHeader } from "../domain/peCoffHeader.js";
import { readElfFixedHeader } from "../domain/elfFixedHeader.js";
import { decodePeMachine } from "../domain/peMachine.js";
import type { ResolvedElectronFuseFile } from "./ElectronFusePath.js";
import { createHash } from "node:crypto";
import { lstat, type FileHandle } from "node:fs/promises";

import { readMachoImage } from "../domain/apple/machoLoadCommandReader.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import {
  hasMachoMagic,
  readFatHeaderPrefix,
} from "../domain/apple/machoContainer.js";
import type { ReadAt } from "../domain/apple/machoLoadCommandReader.js";
import {
  DEFAULT_INSPECT_ELECTRON_FUSES_DECODED_BYTES,
  DEFAULT_INSPECT_ELECTRON_FUSES_FILE_BYTES,
  DEFAULT_INSPECT_ELECTRON_FUSES_SENTINELS_PER_SLICE,
  ELECTRON_FUSE_ENTRY_ESTIMATED_BYTES,
  ELECTRON_FUSE_SENTINEL,
  ELECTRON_FUSE_SENTINEL_ESTIMATED_BYTES,
  ELECTRON_FUSE_SLICE_ESTIMATED_BYTES,
  electronFuseName,
  electronFuseState,
  type ElectronFuseSentinel,
  type ElectronFuseSlice,
} from "../domain/electron/electronFuses.js";
import { machoImageSlices } from "../domain/apple/dylibResolution.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import {
  ArtifactResourceScope,
  assertArtifactReadActive,
  withArtifactRegularFile,
  readFailureError,
} from "../resources/index.js";

/** Admission and search bounds for one Electron executable. */
export const ELECTRON_FUSE_LIMITS = {
  maximumFileBytes: DEFAULT_INSPECT_ELECTRON_FUSES_FILE_BYTES,
  chunkBytes: 256 * 1024,
  maximumSentinelsPerSlice: DEFAULT_INSPECT_ELECTRON_FUSES_SENTINELS_PER_SLICE,
  maximumDecodedBytes: DEFAULT_INSPECT_ELECTRON_FUSES_DECODED_BYTES,
  maximumPeHeaderOffset: 1024 * 1024,
} as const;

const SENTINEL = Buffer.from(ELECTRON_FUSE_SENTINEL, "ascii");

/** Container identity and per-slice fuse wires. Offsets are file-absolute. */
export interface ElectronFuseImage {
  readonly sha256: string;
  readonly bytes: number;
  readonly format: "mach-o" | "mach-o-universal" | "pe" | "elf";
  readonly slices: readonly ElectronFuseSlice[];
}

type ElectronFuseContainerFormat = ElectronFuseImage["format"];

interface SliceRange {
  readonly index: number;
  readonly fileOffset: number;
  readonly size: number;
  readonly architecture: string | null;
  readonly hidden?: boolean;
}

/** A measured bound was hit before a complete fuse report could be returned. */
export class ElectronFuseResourceFailure extends ParseFailureError<"limit"> {
  constructor(
    readonly limit: LimitRef & {
      readonly name:
        | "maximum_input_bytes"
        | "maximum_sentinels_per_slice"
        | "maximum_decoded_bytes";
    },
    message: string,
  ) {
    super({ kind: "limit", format: "electron-fuses", detail: message, limit });
    this.name = "ElectronFuseResourceFailure";
  }
}

/**
 * Hash one admitted regular file and search each slice for the fuse sentinel.
 * The search keeps only a sentinel-sized overlap between chunks.
 */
export const readElectronFuseImage = async (
  path: string,
  options?: {
    readonly signal?: AbortSignal;
    readonly selection?: ResolvedElectronFuseFile;
    readonly resources?: ArtifactResourceScope;
    readonly maxFileBytes?: number;
    readonly maxSentinelsPerSlice?: number;
    readonly maxDecodedBytes?: number;
  },
): Promise<ElectronFuseImage> => {
  const signal = options?.signal;
  const maxFileBytes =
    options?.maxFileBytes ?? ELECTRON_FUSE_LIMITS.maximumFileBytes;
  const maxSentinelsPerSlice =
    options?.maxSentinelsPerSlice ??
    ELECTRON_FUSE_LIMITS.maximumSentinelsPerSlice;
  const maxDecodedBytes =
    options?.maxDecodedBytes ?? ELECTRON_FUSE_LIMITS.maximumDecodedBytes;
  assertArtifactReadActive(signal);
  const selection = options?.selection;
  const recheckPath = async (candidate: string) => {
    assertArtifactReadActive(signal);
    try {
      const metadata = await lstat(candidate, { bigint: true });
      assertArtifactReadActive(signal);
      return metadata;
    } catch (cause: unknown) {
      if (selection !== undefined && isMissingPath(cause))
        throw new RegularFileChangedError(path);
      throw cause;
    }
  };
  const assertPathNodes = async (): Promise<void> => {
    if (selection === undefined) return;
    if (selection.path !== path) throw new RegularFileChangedError(path);
    for (const node of selection.nodes) {
      const current = await recheckPath(node.path);
      if (
        current.dev !== node.metadata.dev ||
        current.ino !== node.metadata.ino ||
        current.isDirectory() !== node.metadata.isDirectory() ||
        current.isSymbolicLink() !== node.metadata.isSymbolicLink()
      )
        throw new RegularFileChangedError(path);
    }
  };
  await assertPathNodes();
  const before = await recheckPath(path);
  if (
    selection !== undefined &&
    !sameRegularFileState(selection.metadata, before)
  )
    throw new RegularFileChangedError(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw unsupportedInput(
      "native-binary",
      `Expected a regular file without a symlink: ${path}`,
    );
  if (before.size > BigInt(maxFileBytes))
    throw new ElectronFuseResourceFailure(
      {
        name: "maximum_input_bytes",
        maximum: maxFileBytes,
        required: before.size,
      },
      `Selected artifact exceeds ${maxFileBytes} bytes: ${path}`,
    );
  const size = Number(before.size);
  return withArtifactRegularFile(
    path,
    options?.resources ?? new ArtifactResourceScope(),
    signal,
    async ({ handle: owned }) => {
      const opened = await owned.stat({ bigint: true });
      if (!sameRegularFileState(before, opened))
        throw new RegularFileChangedError(path);
      await assertPathNodes();
      const readAt = readerFor(owned, size, path, signal);
      const container = await identifyContainer(readAt, size, path);
      const scanned = await scanSlices(
        owned,
        path,
        size,
        container.slices,
        maxSentinelsPerSlice,
        maxDecodedBytes,
        signal,
      );
      const current = await recheckPath(path);
      if (!sameRegularFileState(before, current))
        throw new RegularFileChangedError(path);
      await assertPathNodes();
      return {
        sha256: scanned.sha256,
        bytes: size,
        format: container.format,
        slices: scanned.slices,
      };
    },
  );
};

/** Sentence describing the file and sentinel bounds enforced by this reader. */
export const electronFuseReadLimitation = (limits?: {
  readonly maxFileBytes?: number;
  readonly maxSentinelsPerSlice?: number;
  readonly maxDecodedBytes?: number;
}): string => {
  const maxFileBytes =
    limits?.maxFileBytes ?? ELECTRON_FUSE_LIMITS.maximumFileBytes;
  const maxSentinelsPerSlice =
    limits?.maxSentinelsPerSlice ??
    ELECTRON_FUSE_LIMITS.maximumSentinelsPerSlice;
  const maxDecodedBytes =
    limits?.maxDecodedBytes ?? ELECTRON_FUSE_LIMITS.maximumDecodedBytes;
  const fileLimit =
    maxFileBytes === ELECTRON_FUSE_LIMITS.maximumFileBytes
      ? "1 GiB"
      : `${String(maxFileBytes)} bytes`;
  const decodedLimit =
    maxDecodedBytes === ELECTRON_FUSE_LIMITS.maximumDecodedBytes
      ? "8 MiB"
      : `${String(maxDecodedBytes)} bytes`;
  return `The selected file is admitted as one regular file of at most ${fileLimit}. Sentinel search uses ${ELECTRON_FUSE_LIMITS.chunkBytes}-byte windows, keeps at most ${String(maxSentinelsPerSlice)} sentinels per slice, and bounds estimated decoded fuse data across all slices to ${decodedLimit}.`;
};

const readerFor =
  (
    handle: FileHandle,
    size: number,
    path: string,
    signal: AbortSignal | undefined,
  ): ReadAt =>
  async (offset, length) => {
    assertArtifactReadActive(signal);
    if (length <= 0 || offset < 0 || offset >= size) return new Uint8Array();
    const bounded = Math.min(length, size - offset);
    const buffer = await readFileHandleRange(handle, offset, bounded, () =>
      assertArtifactReadActive(signal),
    );
    if (buffer.length !== bounded) throw new RegularFileChangedError(path);
    return buffer;
  };

const identifyContainer = async (
  readAt: ReadAt,
  size: number,
  path: string,
): Promise<{
  readonly format: ElectronFuseContainerFormat;
  readonly slices: readonly SliceRange[];
}> => {
  const head = await readAt(0, Math.min(size, 8));
  if (hasMachoMagic(head)) return identifyMacho(readAt, size, head, path);
  if (hasElfMagic(head)) {
    const header = await readAt(0, 64);
    const parsed = readElfFixedHeader(Buffer.from(header), size);
    return {
      format: "elf",
      slices: [
        {
          index: 0,
          fileOffset: 0,
          size,
          architecture: parsed.ok ? parsed.value.architecture : null,
        },
      ],
    };
  }
  const pe = await identifyPe(readAt, size);
  if (pe !== undefined)
    return {
      format: "pe",
      slices: [
        { index: 0, fileOffset: 0, size, architecture: pe.architecture },
      ],
    };
  throw unsupportedInput(
    "native-binary",
    `Selected artifact ${path} does not contain a Mach-O, ELF, or PE container.`,
  );
};

const identifyMacho = async (
  readAt: ReadAt,
  size: number,
  head: Uint8Array,
  path: string,
): Promise<{
  readonly format: ElectronFuseContainerFormat;
  readonly slices: readonly SliceRange[];
}> => {
  const facts = await readMachoImage(readAt, size);
  if (facts.status !== "parsed") {
    throw facts.status === "not-mach-o"
      ? unsupportedInput(
          "macho",
          `Selected artifact ${path} does not contain a Mach-O, ELF, or PE container.`,
        )
      : readFailureError(facts.failure);
  }
  const fat = readFatHeaderPrefix(head);
  const format =
    fat.state === "parsed" || fat.state === "incomplete"
      ? "mach-o-universal"
      : "mach-o";
  const slices = machoImageSlices(facts).map((slice, index) => ({
    index,
    fileOffset: slice.slice_offset,
    size: slice.slice_size,
    architecture: slice.architecture,
    ...(slice.hidden === undefined ? {} : { hidden: slice.hidden }),
  }));
  return {
    format,
    slices,
  };
};

const scanSlices = async (
  handle: FileHandle,
  path: string,
  size: number,
  ranges: readonly SliceRange[],
  maxSentinelsPerSlice: number,
  maxDecodedBytes: number,
  signal: AbortSignal | undefined,
): Promise<{
  readonly sha256: string;
  readonly slices: readonly ElectronFuseSlice[];
}> => {
  let decodedBytes = 0;
  const admitDecodedBytes = (bytes: number): void => {
    decodedBytes += bytes;
    if (decodedBytes > maxDecodedBytes)
      throw new ElectronFuseResourceFailure(
        {
          name: "maximum_decoded_bytes",
          maximum: maxDecodedBytes,
        },
        `Decoded Electron fuse report exceeds the ${String(maxDecodedBytes)}-byte representation budget across all slices.`,
      );
  };
  admitDecodedBytes(ranges.length * ELECTRON_FUSE_SLICE_ESTIMATED_BYTES);
  const states = ranges.map((slice) => ({
    slice,
    carry: Buffer.alloc(0),
    hits: [] as number[],
  }));
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(ELECTRON_FUSE_LIMITS.chunkBytes);
  let position = 0;
  while (position < size) {
    assertArtifactReadActive(signal);
    const length = Math.min(chunk.length, size - position);
    const read = await handle.read(chunk, 0, length, position);
    if (read.bytesRead === 0) throw new RegularFileChangedError(path);
    assertArtifactReadActive(signal);
    const piece = chunk.subarray(0, read.bytesRead);
    hash.update(piece);
    absorbChunk(
      states,
      piece,
      position,
      maxSentinelsPerSlice,
      admitDecodedBytes,
    );
    position += read.bytesRead;
  }
  if (position !== size) throw new RegularFileChangedError(path);
  const slices: ElectronFuseSlice[] = [];
  for (const state of states) {
    const sentinels: ElectronFuseSentinel[] = [];
    for (const offset of state.hits)
      sentinels.push(
        await parseWire(
          handle,
          path,
          offset,
          state.slice.fileOffset + state.slice.size,
          admitDecodedBytes,
          signal,
        ),
      );
    slices.push({
      index: state.slice.index,
      file_offset: state.slice.fileOffset,
      size: state.slice.size,
      architecture: state.slice.architecture,
      ...(state.slice.hidden === undefined
        ? {}
        : { hidden: state.slice.hidden }),
      sentinel_count: sentinels.length,
      sentinels,
    });
  }
  return { sha256: hash.digest("hex"), slices };
};

const BOUNDARY_BRIDGE = Buffer.allocUnsafe(2 * (SENTINEL.length - 1));

const recordSentinelHit = (
  state: {
    readonly slice: SliceRange;
    readonly hits: number[];
  },
  sentinelOffset: number,
  maxSentinelsPerSlice: number,
  admitDecodedBytes: (bytes: number) => void,
): void => {
  if (state.hits.includes(sentinelOffset)) return;
  if (state.hits.length >= maxSentinelsPerSlice)
    throw new ElectronFuseResourceFailure(
      {
        name: "maximum_sentinels_per_slice",
        maximum: maxSentinelsPerSlice,
      },
      `Slice ${state.slice.index} contains more than ${maxSentinelsPerSlice} Electron fuse sentinels.`,
    );
  admitDecodedBytes(ELECTRON_FUSE_SENTINEL_ESTIMATED_BYTES);
  state.hits.push(sentinelOffset);
};

const absorbChunk = (
  states: readonly {
    readonly slice: SliceRange;
    carry: Buffer;
    readonly hits: number[];
  }[],
  chunk: Buffer,
  position: number,
  maxSentinelsPerSlice: number,
  admitDecodedBytes: (bytes: number) => void,
): void => {
  const chunkEnd = position + chunk.length;
  const tail = SENTINEL.length - 1;
  for (const state of states) {
    const start = Math.max(position, state.slice.fileOffset);
    const end = Math.min(chunkEnd, state.slice.fileOffset + state.slice.size);
    if (start >= end) continue;
    const piece = chunk.subarray(start - position, end - position);
    const carryLength = state.carry.length;
    // Scan only the small carry+prefix bridge for boundary-straddling matches,
    // then scan `piece` directly without copying the full chunk.
    if (carryLength > 0) {
      const bridgePieceLength = Math.min(piece.length, tail);
      const bridgeLength = carryLength + bridgePieceLength;
      if (bridgeLength >= SENTINEL.length) {
        state.carry.copy(BOUNDARY_BRIDGE, 0, 0, carryLength);
        piece.copy(BOUNDARY_BRIDGE, carryLength, 0, bridgePieceLength);
        const bridge = BOUNDARY_BRIDGE.subarray(0, bridgeLength);
        const bridgeFileStart = start - carryLength;
        let from = 0;
        while (from <= bridgeLength - SENTINEL.length) {
          const found = bridge.indexOf(SENTINEL, from);
          if (found < 0) break;
          recordSentinelHit(
            state,
            bridgeFileStart + found,
            maxSentinelsPerSlice,
            admitDecodedBytes,
          );
          from = found + 1;
        }
      }
    }
    let from = 0;
    while (from <= piece.length - SENTINEL.length) {
      const found = piece.indexOf(SENTINEL, from);
      if (found < 0) break;
      recordSentinelHit(
        state,
        start + found,
        maxSentinelsPerSlice,
        admitDecodedBytes,
      );
      from = found + 1;
    }
    if (piece.length >= tail) {
      state.carry = Buffer.from(piece.subarray(piece.length - tail));
    } else {
      const keepCarry = Math.min(carryLength, tail - piece.length);
      const nextCarry = Buffer.allocUnsafe(keepCarry + piece.length);
      if (keepCarry > 0)
        state.carry.copy(nextCarry, 0, carryLength - keepCarry, carryLength);
      piece.copy(nextCarry, keepCarry);
      state.carry = nextCarry;
    }
  }
};

const parseWire = async (
  handle: FileHandle,
  path: string,
  sentinelOffset: number,
  sliceEnd: number,
  admitDecodedBytes: (bytes: number) => void,
  signal: AbortSignal | undefined,
): Promise<ElectronFuseSentinel> => {
  const wireStart = sentinelOffset + SENTINEL.length;
  const available = sliceEnd - wireStart;
  if (available < 1)
    return {
      sentinel_offset: sentinelOffset,
      wire_version: null,
      declared_length: null,
      fuses: [],
      complete: false,
    };
  const header = await readExact(
    handle,
    path,
    wireStart,
    Math.min(available, 2),
    signal,
  );
  const wireVersion = header[0];
  if (wireVersion === undefined || header.length < 2)
    return {
      sentinel_offset: sentinelOffset,
      wire_version: wireVersion ?? null,
      declared_length: null,
      fuses: [],
      complete: false,
    };
  const declared = header[1] ?? 0;
  const fuseLength = Math.min(declared, available - 2);
  admitDecodedBytes(fuseLength * ELECTRON_FUSE_ENTRY_ESTIMATED_BYTES);
  const fuseBytes =
    fuseLength === 0
      ? Buffer.alloc(0)
      : await readExact(handle, path, wireStart + 2, fuseLength, signal);
  return {
    sentinel_offset: sentinelOffset,
    wire_version: wireVersion,
    declared_length: declared,
    fuses: [...fuseBytes].map((raw, index) => ({
      index,
      name: electronFuseName(wireVersion, index),
      state: electronFuseState(raw),
      raw_byte: raw,
    })),
    complete: fuseBytes.length === declared,
  };
};

const readExact = async (
  handle: FileHandle,
  path: string,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  const buffer = await readFileHandleRange(handle, offset, length, () =>
    assertArtifactReadActive(signal),
  );
  if (buffer.length !== length) throw new RegularFileChangedError(path);
  return buffer;
};

const identifyPe = async (
  readAt: ReadAt,
  size: number,
): Promise<{ readonly architecture: string | null } | undefined> => {
  if (size < 64) return undefined;
  const header = await readAt(0, 64);
  if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a)
    return undefined;
  const prefix = Buffer.from(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  const observed = observeMzWindowsHeader(prefix, size);
  if (observed.state !== "signature-needed" && observed.state !== "declared")
    return undefined;
  const offset = observed.offset;
  if (
    offset < 64 ||
    offset > ELECTRON_FUSE_LIMITS.maximumPeHeaderOffset ||
    offset > size - 4
  )
    return undefined;
  const bytes = Buffer.from(await readAt(offset, 24));
  const confirmed = observeMzWindowsHeader(prefix, size, { offset, bytes });
  if (confirmed.state !== "declared" || confirmed.signature !== "PE")
    return undefined;
  // A signature establishes the existing scan boundary; only a complete COFF
  // header establishes its machine. Managed OS overrides need separate proof.
  const coff = readPeCoffHeader(bytes.subarray(4));
  const machine =
    bytes.length === 24 && coff.ok
      ? decodePeMachine(coff.value.machine)
      : undefined;
  return {
    architecture:
      machine?.nativeOsOverride === false ? machine.architecture : null,
  };
};

const isMissingPath = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR"].includes(String(cause.code));
