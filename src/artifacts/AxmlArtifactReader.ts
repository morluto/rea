import {
  createAxmlDecoder,
  DEFAULT_AXML_DECODE_LIMITS,
  type AxmlDecodeLimits,
  type AxmlDocumentImage,
} from "../domain/android/axmlDocument.js";
import type { AxmlReaderLimits } from "../domain/artifactReaderLimits.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const axmlRegions = (
  limits: AxmlDecodeLimits,
): RegionDecoding<AxmlDocumentImage> => ({
  label: "axml",
  keyPrefix: "axml",
  createDecoder: (fileBytes) => createAxmlDecoder(fileBytes, limits),
  describe: (image) => ({
    metadata: { kind: "axml", ...image.metadata },
    regions: [
      {
        path: "document.xml",
        byteOffset: null,
        formatMetadata: {
          kind: "axml-document",
          element_count: image.metadata.element_count,
          attribute_count: image.metadata.attribute_count,
          namespace_count: image.metadata.namespace_count,
          string_count: image.metadata.string_count,
          length: image.xml.length,
        },
        bytes: image.xml,
      },
    ],
    coverage: {
      // Uninterpreted chunks or unexamined carrier tails cannot claim
      // complete coverage even when the document itself terminated cleanly.
      status: image.terminated && !image.unexamined ? "complete" : "unknown",
      limitations: image.limitations,
    },
  }),
});

/** Per-call artifact_limits fields map onto the decoder's own shape. */
const decodeLimits = (selected?: AxmlReaderLimits): AxmlDecodeLimits => ({
  fileBytes: selected?.file_bytes ?? DEFAULT_AXML_DECODE_LIMITS.fileBytes,
  strings: selected?.strings ?? DEFAULT_AXML_DECODE_LIMITS.strings,
  stringBytes: selected?.string_bytes ?? DEFAULT_AXML_DECODE_LIMITS.stringBytes,
  elements: selected?.elements ?? DEFAULT_AXML_DECODE_LIMITS.elements,
  attributes: selected?.attributes ?? DEFAULT_AXML_DECODE_LIMITS.attributes,
  namespaces: selected?.namespaces ?? DEFAULT_AXML_DECODE_LIMITS.namespaces,
  depth: selected?.depth ?? DEFAULT_AXML_DECODE_LIMITS.depth,
  outputBytes: selected?.output_bytes ?? DEFAULT_AXML_DECODE_LIMITS.outputBytes,
});

/** Decode an Android binary XML document into its XML text region. */
export class AxmlArtifactReader extends DecodedRegionArtifactReader<AxmlDocumentImage> {
  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits?: AxmlReaderLimits,
  ) {
    super(path, "axml", axmlRegions(decodeLimits(limits)), admitted);
  }
}
