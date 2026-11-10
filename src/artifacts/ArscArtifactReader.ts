import {
  createArscDecoder,
  type ArscDocumentImage,
} from "../domain/android/arscDocument.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const arscRegions: RegionDecoding<ArscDocumentImage> = {
  label: "arsc",
  keyPrefix: "arsc",
  createDecoder: (fileBytes) => createArscDecoder(fileBytes),
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

/** Decode an Android compiled resource table into its XML text region. */
export class ArscArtifactReader extends DecodedRegionArtifactReader<ArscDocumentImage> {
  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "arsc", arscRegions, admitted);
  }
}
