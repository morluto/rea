import {
  createArscDecoder,
  DEFAULT_ARSC_DECODE_LIMITS,
  type ArscDecodeLimits,
  type ArscDocumentImage,
} from "../domain/android/arscDocument.js";
import type { ArscReaderLimits } from "../domain/artifactReaderLimits.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const arscRegions = (
  limits: ArscDecodeLimits,
): RegionDecoding<ArscDocumentImage> => ({
  label: "arsc",
  keyPrefix: "arsc",
  createDecoder: (fileBytes) => createArscDecoder(fileBytes, limits),
  describe: (image) => ({
    metadata: { kind: "arsc", ...image.metadata },
    regions: [
      {
        path: "resources.xml",
        byteOffset: null,
        formatMetadata: {
          kind: "arsc-document",
          package_count: image.metadata.package_count,
          type_count: image.metadata.type_count,
          entry_count: image.metadata.entry_count,
          string_count: image.metadata.string_count,
          length: image.xml.length,
        },
        bytes: image.xml,
      },
    ],
    coverage: {
      status: image.terminated ? "complete" : "unknown",
      limitations: image.limitations,
    },
  }),
});

/** Per-call artifact_limits fields map onto the decoder's own shape. */
const decodeLimits = (selected?: ArscReaderLimits): ArscDecodeLimits => ({
  fileBytes: selected?.file_bytes ?? DEFAULT_ARSC_DECODE_LIMITS.fileBytes,
  packages: selected?.packages ?? DEFAULT_ARSC_DECODE_LIMITS.packages,
  strings: selected?.strings ?? DEFAULT_ARSC_DECODE_LIMITS.strings,
  stringBytes: selected?.string_bytes ?? DEFAULT_ARSC_DECODE_LIMITS.stringBytes,
  entries: selected?.entries ?? DEFAULT_ARSC_DECODE_LIMITS.entries,
  outputBytes: selected?.output_bytes ?? DEFAULT_ARSC_DECODE_LIMITS.outputBytes,
});

/** Decode an Android compiled resource table into its XML text region. */
export class ArscArtifactReader extends DecodedRegionArtifactReader<ArscDocumentImage> {
  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits?: ArscReaderLimits,
  ) {
    super(path, "arsc", arscRegions(decodeLimits(limits)), admitted);
  }
}
