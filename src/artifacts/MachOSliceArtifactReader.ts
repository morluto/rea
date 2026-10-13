import { lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  XcrunCommandRunner,
  type NativeCommandRunner,
} from "../native/CommandRunner.js";
import {
  parseLipoArchitectures,
  type LipoArchitecture,
} from "../native/parsers/lipo.js";
import type { MachoSlice } from "../domain/apple/dylibResolution.js";
import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readMachoImage, type ReadAt } from "./apple/MachoLoadCommandReader.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";

/** Read-only universal Mach-O slice reader backed by native lipo metadata. */
export class MachOSliceArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  #command: ArtifactCommand | undefined;
  #source: StableRegularFileDescriptor | undefined;
  #ownedSource: OwnedFileHandle | undefined;
  #pendingSource: Promise<StableRegularFileDescriptor> | undefined;
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #pendingCommands = new Set<Promise<unknown>>();
  readonly #ownsSource: boolean;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(
      environment,
    ),
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
    this.#ownsSource = source === undefined;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    this.#entries.clear();
    const source = await this.#ensureSource();
    await this.#verifySource(source);
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Universal Mach-O reader is closed",
      );
    const command = this.runner.run(
      "lipo",
      ["-detailed_info", this.path],
      signal === undefined ? {} : { signal },
    );
    this.#pendingCommands.add(command);
    let captured: Awaited<typeof command>;
    try {
      captured = await command;
    } finally {
      this.#pendingCommands.delete(command);
    }
    if (!captured.ok)
      throw new ArtifactReaderFailure(
        captured.error.reason === "cancelled" ? "cancelled" : "unavailable",
        captured.error.detail === null
          ? "lipo could not enumerate universal Mach-O slices"
          : `lipo could not enumerate universal Mach-O slices: ${captured.error.detail}`,
        {
          cause: captured.error,
          ...(captured.error.cleanupFailure === null &&
          captured.error.cleanupResources.length === 0
            ? {}
            : {
                cleanup: {
                  reason:
                    captured.error.cleanupFailure ??
                    "Native command cleanup remains unverified",
                  resources: [...captured.error.cleanupResources],
                },
              }),
        },
      );
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Universal Mach-O reader closed during slice discovery",
      );
    this.#command = {
      tool: captured.value.tool,
      arguments: ["-detailed_info", "$ARTIFACT"],
      tool_version: captured.value.toolVersion,
      executable_sha256: captured.value.executableSha256,
      exit_code: captured.value.exitCode,
      effects: ["read"],
    };
    await this.#verifySource(source);
    const fileSize = source.initial.size;
    const architectures = parseLipoArchitectures(captured.value.stdout);
    const structural = await readStructuralSlices(source.handle, fileSize);
    await this.#verifySource(source);
    if (structural.status === "malformed")
      throw new ArtifactReaderFailure(
        "integrity",
        `Mach-O structural slice index is malformed: ${structural.reason}`,
      );
    if (structural.status === "unsupported")
      throw new ArtifactReaderFailure(
        "format",
        `Mach-O structural slice index is unsupported: ${structural.reason}`,
      );
    const slices = structural.status === "parsed" ? structural.slices : null;
    const matchingSlices = new Map<LipoArchitecture, MachoSlice>();
    if (slices !== null) {
      if (slices.length !== architectures.length)
        throw new ArtifactReaderFailure(
          "integrity",
          "lipo architecture count disagrees with the Mach-O FAT table",
        );
      const unmatched = [...slices];
      for (const reported of architectures) {
        const match = unmatched.findIndex((observed) =>
          lipoMatchesSlice(reported, observed, slices.length === 1),
        );
        if (match < 0)
          throw new ArtifactReaderFailure(
            "integrity",
            `lipo slice metadata disagrees with the Mach-O FAT table: ${reported.name} (cputype=${reported.cpu_type ?? "unknown"}, cpusubtype=${reported.cpu_subtype ?? "unknown"}, offset=${reported.file_offset ?? "unknown"}, size=${reported.size ?? "unknown"}, alignment=${reported.alignment ?? "unknown"})`,
          );
        const [observed] = unmatched.splice(match, 1);
        if (observed !== undefined) matchingSlices.set(reported, observed);
      }
    }
    for (const architecture of architectures) {
      const structuralSlice = matchingSlices.get(architecture);
      const offset = architecture.file_offset ?? structuralSlice?.slice_offset;
      const sliceSize = architecture.size ?? structuralSlice?.slice_size;
      if (offset === undefined || sliceSize === undefined)
        throw new ArtifactReaderFailure(
          "integrity",
          "lipo omitted a universal slice byte range",
        );
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(sliceSize) ||
        offset < 0 ||
        sliceSize <= 0 ||
        !Number.isSafeInteger(offset + sliceSize) ||
        offset + sliceSize > fileSize
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `lipo reported an out-of-bounds Mach-O slice: ${architecture.name}`,
        );
      const entry: ArtifactEntry = {
        path: `slices/${architecture.name}`,
        kind: "slice",
        declaredSize: sliceSize,
        compressedSize: null,
        executable: true,
        encrypted: false,
        byteOffset: offset,
        declaredSha256: null,
        unpacked: false,
        limitations: [
          ...(structural.status === "not-mach-o"
            ? [
                "Structural Mach-O facts were unavailable; slice range is based on lipo output.",
              ]
            : []),
          ...(architecture.file_offset === null || architecture.size === null
            ? [
                "Slice range was derived from structural Mach-O facts because lipo omitted it.",
              ]
            : []),
          ...(architecture.cpu_type !== null &&
          architecture.cpu_type_code === null
            ? [
                `lipo CPU type is retained as unnormalized source text: ${architecture.cpu_type}`,
              ]
            : []),
          ...(architecture.cpu_subtype !== null &&
          architecture.cpu_subtype_code === null
            ? [
                `lipo CPU subtype is retained as unnormalized source text: ${architecture.cpu_subtype}${architecture.capabilities === null ? "" : `; capabilities ${architecture.capabilities}`}`,
              ]
            : []),
        ],
        adapterKey: `${String(offset)}:${String(sliceSize)}`,
      };
      this.#entries.set(entry.adapterKey, copyArtifactEntry(entry));
      yield entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (signal?.aborted === true)
      return Promise.reject(
        new ArtifactReaderFailure("cancelled", "Mach-O slice read cancelled"),
      );
    const produced = this.#entries.get(entry.adapterKey);
    if (produced === undefined || !sameArtifactEntry(entry, produced))
      throw new ArtifactReaderFailure(
        "integrity",
        "Mach-O slice entry metadata does not match this reader's inventory",
      );
    const offset = produced.byteOffset;
    const size = produced.declaredSize;
    if (
      offset === null ||
      size === null ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size <= 0
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Invalid Mach-O slice byte range",
      );
    const source = await this.#ensureSource();
    await this.#verifySource(source);
    if (
      !Number.isSafeInteger(offset + size) ||
      offset + size > source.initial.size
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Mach-O slice range is outside the artifact: ${entry.path}`,
      );
    const sourceStream = readFileHandleChunks(source.handle, {
      start: offset,
      end: offset + size - 1,
      ...(signal === undefined ? {} : { signal }),
    });
    const verifySource = () => this.#verifySource(source);
    return Readable.from(
      (async function* () {
        let observedBytes = 0;
        try {
          for await (const raw of sourceStream) {
            const chunk = streamChunkToBuffer(raw);
            observedBytes += chunk.byteLength;
            if (observedBytes > size)
              throw new ArtifactReaderFailure(
                "integrity",
                `Mach-O slice exceeded its reported size: ${entry.path}`,
              );
            yield chunk;
          }
        } catch (cause: unknown) {
          if (cause instanceof ArtifactReaderFailure) throw cause;
          if (signal?.aborted === true)
            throw new ArtifactReaderFailure(
              "cancelled",
              "Mach-O slice read cancelled",
              { cause },
            );
          throw new ArtifactReaderFailure(
            "integrity",
            `Could not read Mach-O slice range: ${entry.path}`,
            { cause },
          );
        }
        if (observedBytes !== size)
          throw new ArtifactReaderFailure(
            "integrity",
            `Mach-O slice size disagrees with lipo metadata: ${entry.path}`,
          );
        await verifySource();
      })(),
    );
  }

  provenance(): readonly ArtifactCommand[] {
    return this.#command === undefined ? [] : [structuredClone(this.#command)];
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= this.#releaseResources().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  async #releaseResources(): Promise<void> {
    await Promise.allSettled(this.#pendingCommands);
    let cleanup: ArtifactReaderFailure["cleanup"];
    try {
      const failures = (await this.runner.retryCleanup?.()) ?? [];
      if (failures.length > 0)
        cleanup = {
          reason: failures
            .map(
              ({ reason, resources }) => `${resources.join(", ")}: ${reason}`,
            )
            .join("; "),
          resources: [
            ...new Set(failures.flatMap(({ resources }) => resources)),
          ],
        };
    } catch (cause: unknown) {
      cleanup = ArtifactReaderFailure.cleanupObservation(
        cause,
        "native-command-process-cleanup",
      );
    }
    try {
      await this.#closeSource();
    } catch (cause: unknown) {
      if (cleanup === undefined) throw cause;
      throw ArtifactReaderFailure.withCleanup(cause, cleanup);
    }
    if (cleanup !== undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Native command process cleanup remains incomplete",
        { cleanup },
      );
  }

  async #ensureSource(): Promise<StableRegularFileDescriptor> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Universal Mach-O reader is closed",
      );
    if (this.#source !== undefined) return this.#source;
    this.#pendingSource ??= this.#acquireSource();
    const source = await this.#pendingSource;
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Universal Mach-O reader closed during source acquisition",
      );
    return source;
  }

  async #acquireSource(): Promise<StableRegularFileDescriptor> {
    let handle: FileHandle;
    try {
      handle = await openRegularFile(this.path, { symlinks: "reject" });
    } catch (cause: unknown) {
      if (!(cause instanceof RegularFileAdmissionFailure)) throw cause;
      this.#ownedSource = cause.owner;
      const primary =
        cause.cause instanceof NonRegularFileReadError
          ? new ArtifactReaderFailure(
              "format",
              `Universal Mach-O source is not a regular file: ${this.path}`,
              { cause: cause.cause },
            )
          : cause.cause;
      throw ArtifactReaderFailure.withCleanup(
        primary,
        ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, this.path),
      );
    }
    const owner = new OwnedFileHandle(handle);
    this.#ownedSource = owner;
    try {
      const initial = await handle.stat();
      const source = { handle, initial };
      this.#source = source;
      return source;
    } catch (cause: unknown) {
      try {
        await owner.close();
        this.#ownedSource = undefined;
      } catch (cleanupCause: unknown) {
        throw ArtifactReaderFailure.withCleanup(
          cause,
          ArtifactReaderFailure.cleanupObservation(cleanupCause, this.path),
        );
      }
      throw cause;
    }
  }

  async #closeSource(): Promise<void> {
    await this.#pendingSource?.catch(() => undefined);
    if (!this.#ownsSource || this.#ownedSource === undefined) return;
    await this.#ownedSource.close();
    this.#ownedSource = undefined;
    this.#source = undefined;
  }

  async #verifySource(source: StableRegularFileDescriptor): Promise<void> {
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Universal Mach-O source changed during inventory: ${this.path}`,
      );
  }
}

/** Compare lipo's independent ranges with structurally parsed slice identity. */
const readStructuralSlices = async (
  file: FileHandle,
  size: number,
): Promise<Awaited<ReturnType<typeof readMachoImage>>> => {
  const readAt: ReadAt = async (offset, length) => {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    return bytes.subarray(0, bytesRead);
  };
  return readMachoImage(readAt, size);
};

const lipoMatchesSlice = (
  reported: LipoArchitecture,
  observed: MachoSlice,
  structurallyUnique: boolean,
): boolean => {
  const observedCpuType = observed.fat_cpu_type ?? observed.cpu_type;
  const observedCpuSubtype = observed.fat_cpu_subtype ?? observed.cpu_subtype;
  const hasPhysicalIdentity =
    reported.file_offset !== null ||
    reported.size !== null ||
    reported.cpu_type_code !== null ||
    reported.cpu_subtype_code !== null;
  return (
    (hasPhysicalIdentity || structurallyUnique) &&
    lipoNameMatches(reported.name, observed.architecture) &&
    (reported.file_offset === null ||
      reported.file_offset === observed.slice_offset) &&
    (reported.size === null || reported.size === observed.slice_size) &&
    (reported.cpu_type_code === null ||
      reported.cpu_type_code === observedCpuType) &&
    lipoSubtypeMatches(reported, observedCpuSubtype) &&
    (reported.alignment === null ||
      observed.fat_alignment_exponent === null ||
      reported.alignment === 2 ** observed.fat_alignment_exponent)
  );
};

/**
 * Compare the complete subtype when lipo printed its capability byte, and
 * otherwise only the subtype bits its record names.
 */
const lipoSubtypeMatches = (
  reported: LipoArchitecture,
  observedCpuSubtype: number,
): boolean => {
  if (reported.cpu_subtype_code !== null)
    return reported.cpu_subtype_code === observedCpuSubtype;
  return (
    reported.cpu_subtype_base === null ||
    reported.cpu_subtype_base === machoCpuSubtypeBase(observedCpuSubtype)
  );
};

/**
 * Newer lipo names an arm64e ABI variant `arm64e.<variant>` (for example
 * `arm64e.v1` for pointer-auth ABI version 1). The FAT table names that slice
 * `arm64e`; its physical identity is still compared field by field.
 */
const lipoNameMatches = (reported: string, observed: string): boolean =>
  reported === observed ||
  (observed === "arm64e" && /^arm64e\.[A-Za-z0-9_]+$/u.test(reported));
