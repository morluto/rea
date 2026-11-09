import {
  createAxmlDecoder,
  type AxmlDocumentImage,
} from "../domain/android/axmlDocument.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const axmlRegions: RegionDecoding<AxmlDocumentImage> = {
  label: "axml",
  keyPrefix: "axml",
  createDecoder: (fileBytes) => createAxmlDecoder(fileBytes),
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
    ...(image.terminated && image.limitations.length === 0
      ? {}
      : {
          coverage: {
            status: image.terminated ? "complete" : "unknown",
            limitations: image.limitations,
          },
        }),
  }),
};

/** Decode an Android binary XML document into its XML text region. */
export class AxmlArtifactReader extends DecodedRegionArtifactReader<AxmlDocumentImage> {
  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "axml", axmlRegions, admitted);
  }
}
