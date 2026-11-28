import type {
  Image4EntryMetadata,
  Image4Metadata,
} from "../domain/formatMetadata/firmwareMetadata.js";
import { image4MetadataSchema } from "../domain/formatMetadata/firmwareMetadata.js";
import {
  IMAGE4_DER_DEPTH_LIMIT,
  IMAGE4_DER_ELEMENTS_LIMIT,
  IMAGE4_PROPERTIES_LIMIT,
  IMAGE4_STRING_BYTES_LIMIT,
  inspectImage4,
  type Image4EntryFact,
} from "../domain/apple/image4.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
  malformedArtifact,
  type ArtifactReaderFailure,
} from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

/**
 * Inventory an Image4 container's stored payload, manifest and restore info.
 * Keybags are counted, not decrypted. Signatures are sized, not checked.
 * Compressed payloads are not expanded.
 */
export class Image4ArtifactReader extends PositionalArtifactReader<Image4Metadata> {
  override readonly format = "apple-img4" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "Image4", admitted);
  }

  formatMetadata(): Image4Metadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override entryEndedEarly(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure {
    return malformedArtifact(
      "apple-img4",
      `Image4 entry ended early: ${entry.path}`,
    );
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<Image4Metadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const assertActive = (): void => this.assertOpen(signal);
    let inspection;
    try {
      inspection = await inspectImage4({
        length: initial.size,
        read: (offset, length) =>
          readFileHandleRange(handle, offset, length, assertActive),
      });
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError) {
        if (cause.failure.kind === "limit") {
          const { name, maximum } = cause.failure.limit;
          if (name === IMAGE4_DER_DEPTH_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Image4 DER depth allowance",
                kind: "parser",
                limit: maximum,
                unit: "levels",
              },
              cause.message,
              "capacity",
              { cause },
            );
          if (name === IMAGE4_DER_ELEMENTS_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Image4 DER element allowance",
                kind: "parser",
                limit: maximum,
                unit: "elements",
              },
              cause.message,
              "capacity",
              { cause },
            );
          if (name === IMAGE4_PROPERTIES_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Image4 property allowance",
                kind: "parser",
                limit: maximum,
                unit: "properties",
              },
              cause.message,
              "capacity",
              { cause },
            );
          if (name === IMAGE4_STRING_BYTES_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Image4 string allowance",
                kind: "parser",
                limit: maximum,
                unit: "bytes",
              },
              cause.message,
              "memory",
              { cause },
            );
        }
        throw artifactParseFailure(cause, signal);
      }
      throw cause;
    }
    if (inspection.kind === "unrecognized")
      throw malformedArtifact(
        "apple-img4",
        `Image4 header: ${inspection.detail}`,
        { offset: 0, field: "header" },
      );
    return {
      entries: inspection.entries.map(entryOf),
      coverage: {
        status: inspection.limitations.length === 0 ? "complete" : "unknown",
        limitations: [...inspection.limitations],
      },
      formatMetadata: image4MetadataSchema.parse(inspection.facts),
    };
  }
}

const entryOf = (entry: Image4EntryFact): PositionalArtifactEntry => ({
  path: entry.path,
  kind: "file",
  declaredSize: entry.length,
  compressedSize: entry.compression === "none" ? null : entry.length,
  executable: false,
  encrypted: entry.encrypted,
  byteOffset: entry.offset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey:
    entry.role === "payload"
      ? "apple-img4:payload"
      : entry.role === "manifest"
        ? "apple-img4:manifest"
        : "apple-img4:restore-info",
  formatMetadata: {
    kind: "apple-img4-entry" as const,
    role: entry.role,
    decoded: false as const,
    encrypted: entry.encrypted,
    compression: entry.compression,
  } satisfies Image4EntryMetadata,
});
