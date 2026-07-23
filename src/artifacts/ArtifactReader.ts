import type { Readable } from "node:stream";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { ZipPackageFormat } from "../domain/zipPackageFormat.js";

/** Archive-neutral entry metadata. Reader adapters never choose output paths. */
export interface ArtifactEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "slice";
  readonly declaredSize: number | null;
  readonly compressedSize: number | null;
  readonly executable: boolean;
  readonly encrypted: boolean;
  readonly byteOffset: number | null;
  readonly declaredSha256: string | null;
  readonly unpacked: boolean;
  readonly limitations: readonly string[];
  readonly adapterKey: string;
  /** Filesystem identity captured during traversal, when supplied by an adapter. */
  readonly sourceIdentity?: {
    readonly device: number;
    readonly inode: number;
  };
}

/** Read-only adapter over one directory, archive, or virtual container. */
export interface ArtifactReader {
  readonly format: "directory" | ZipPackageFormat | "asar" | "file";
  entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry>;
  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable>;
  provenance(): readonly ArtifactCommand[];
  close(): Promise<void>;
}

/** Hard traversal limits shared by every reader and extraction operation. */
export interface ArtifactLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
}

/** Typed adapter failure translated at provider boundary. */
export class ArtifactReaderFailure extends Error {
  constructor(
    readonly reason:
      | "cancelled"
      | "format"
      | "integrity"
      | "limit"
      | "path"
      | "unavailable",
    message: string,
    options?: ErrorOptions,
    readonly details?: Readonly<{
      logicalPath: string;
      declaredSha256: string | null;
      calculatedSha256: string | null;
      unpacked: boolean;
    }>,
  ) {
    super(message, options);
    this.name = "ArtifactReaderFailure";
  }
}
