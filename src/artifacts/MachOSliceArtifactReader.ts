import { createReadStream } from "node:fs";
import { open as openFile, stat } from "node:fs/promises";
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
import { readMachoImage, type ReadAt } from "./apple/MachoLoadCommandReader.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

/** Read-only universal Mach-O slice reader backed by native lipo metadata. */
export class MachOSliceArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  #command: ArtifactCommand | undefined;

  constructor(
    private readonly path: string,
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(),
  ) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const captured = await this.runner.run(
      "lipo",
      ["-detailed_info", this.path],
      signal === undefined ? {} : { signal },
    );
    if (!captured.ok)
      throw new ArtifactReaderFailure(
        captured.error.reason === "cancelled" ? "cancelled" : "unavailable",
        "lipo could not enumerate universal Mach-O slices",
        { cause: captured.error },
      );
    this.#command = {
      tool: captured.value.tool,
      arguments: ["-detailed_info", "$ARTIFACT"],
      tool_version: captured.value.toolVersion,
      executable_sha256: captured.value.executableSha256,
      exit_code: captured.value.exitCode,
      effects: ["read"],
    };
    const fileSize = (await stat(this.path)).size;
    const architectures = parseLipoArchitectures(captured.value.stdout);
    const structural = await readStructuralSlices(this.path, fileSize);
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
      yield {
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
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (signal?.aborted === true)
      return Promise.reject(
        new ArtifactReaderFailure("cancelled", "Mach-O slice read cancelled"),
      );
    const [offsetText, sizeText] = entry.adapterKey.split(":");
    const offset = parseSliceKeyInteger(offsetText);
    const size = parseSliceKeyInteger(sizeText);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset === null ||
      size === null ||
      offset < 0 ||
      size <= 0
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Invalid Mach-O slice byte range",
      );
    const fileSize = (await stat(this.path)).size;
    if (!Number.isSafeInteger(offset + size) || offset + size > fileSize)
      throw new ArtifactReaderFailure(
        "integrity",
        `Mach-O slice range is outside the artifact: ${entry.path}`,
      );
    const source = createReadStream(this.path, {
      start: offset,
      end: offset + size - 1,
      ...(signal === undefined ? {} : { signal }),
    });
    return Readable.from(
      (async function* () {
        let observedBytes = 0;
        try {
          for await (const raw of source) {
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
      })(),
    );
  }

  provenance(): readonly ArtifactCommand[] {
    return this.#command === undefined ? [] : [structuredClone(this.#command)];
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Compare lipo's independent ranges with structurally parsed slice identity. */
const readStructuralSlices = async (
  path: string,
  size: number,
): Promise<Awaited<ReturnType<typeof readMachoImage>>> => {
  const file = await openFile(path, "r");
  try {
    const readAt: ReadAt = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    };
    const facts = await readMachoImage(readAt, size);
    return facts;
  } finally {
    await file.close();
  }
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
    (reported.cpu_subtype_code === null ||
      reported.cpu_subtype_code === observedCpuSubtype) &&
    (reported.alignment === null ||
      observed.fat_alignment_exponent === null ||
      reported.alignment === 2 ** observed.fat_alignment_exponent)
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

const parseSliceKeyInteger = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
