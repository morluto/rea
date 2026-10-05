import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  XcrunCommandRunner,
  type NativeCommandRunner,
} from "../native/CommandRunner.js";
import { parseLipoArchitectures } from "../native/parsers/lipo.js";
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
    for (const architecture of parseLipoArchitectures(captured.value.stdout)) {
      if (architecture.file_offset === null || architecture.size === null)
        throw new ArtifactReaderFailure(
          "integrity",
          "lipo omitted a universal slice byte range",
        );
      if (
        !Number.isSafeInteger(architecture.file_offset) ||
        !Number.isSafeInteger(architecture.size) ||
        architecture.file_offset < 0 ||
        architecture.size <= 0 ||
        !Number.isSafeInteger(architecture.file_offset + architecture.size) ||
        architecture.file_offset + architecture.size > fileSize
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `lipo reported an out-of-bounds Mach-O slice: ${architecture.name}`,
        );
      yield {
        path: `slices/${architecture.name}`,
        kind: "slice",
        declaredSize: architecture.size,
        compressedSize: null,
        executable: true,
        encrypted: false,
        byteOffset: architecture.file_offset,
        declaredSha256: null,
        unpacked: false,
        limitations: [],
        adapterKey: `${String(architecture.file_offset)}:${String(architecture.size)}`,
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

const parseSliceKeyInteger = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
