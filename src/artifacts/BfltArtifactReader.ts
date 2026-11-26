import {
  createBfltDecoder,
  type BfltExecutable,
} from "../domain/bfltExecutable.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const bfltRegions = (
  expandedBytes: number | undefined,
): RegionDecoding<BfltExecutable> => ({
  label: "bFLT",
  keyPrefix: "bflt",
  createDecoder: (fileBytes) => createBfltDecoder(fileBytes, expandedBytes),
  describe: (executable) => ({
    metadata: executable.metadata,
    regions: executable.segments.map((segment) => ({
      path: segment.path,
      byteOffset: segment.fileOffset,
      formatMetadata: segment.metadata,
      bytes: segment.bytes,
    })),
    coverage: {
      status: executable.complete ? "complete" : "unknown",
      limitations: executable.limitations,
    },
  }),
});

/** Inventory a uClinux flat executable's segments without running it. */
export class BfltArtifactReader extends DecodedRegionArtifactReader<BfltExecutable> {
  /** `expandedBytes` is `artifact_limits.expanded_bytes` for gzip bodies. */
  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    expandedBytes?: number,
  ) {
    super(path, "bflt", bfltRegions(expandedBytes), admitted);
  }
}
