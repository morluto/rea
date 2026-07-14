import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

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
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 30_000,
        maxOutputBytes: 4 * 1024 * 1024,
      },
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
    for (const architecture of parseLipoArchitectures(captured.value.stdout)) {
      if (architecture.file_offset === null || architecture.size === null)
        throw new ArtifactReaderFailure(
          "integrity",
          "lipo omitted a universal slice byte range",
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

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (signal?.aborted === true)
      return Promise.reject(
        new ArtifactReaderFailure("cancelled", "Mach-O slice read cancelled"),
      );
    const [offsetText, sizeText] = entry.adapterKey.split(":");
    const offset = Number(offsetText);
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      size <= 0
    )
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          "Invalid Mach-O slice byte range",
        ),
      );
    return Promise.resolve(
      createReadStream(this.path, { start: offset, end: offset + size - 1 }),
    );
  }

  provenance(): readonly ArtifactCommand[] {
    return this.#command === undefined ? [] : [structuredClone(this.#command)];
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
