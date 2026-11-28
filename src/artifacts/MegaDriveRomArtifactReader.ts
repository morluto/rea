import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createMegaDriveRomDecoder,
  MEGA_DRIVE_MAX_ROM_BYTES,
  MEGA_DRIVE_MAX_SMD_BLOCKS,
  type MegaDriveRom,
} from "../domain/megaDriveRom.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactFixedLimitFailure,
  type ArtifactReaderFailure,
} from "../resources/index.js";
import {
  DecodedRegionArtifactReader,
  type RegionDecoding,
} from "./DecodedRegionArtifactReader.js";

const megaDriveLimitFailure = (
  failure: RegionDecodeFailure,
): ArtifactReaderFailure | undefined => {
  if (failure.ceiling === "rom-bytes")
    return artifactFixedLimitFailure(
      {
        name: "The Mega Drive ROM byte ceiling",
        kind: "input",
        limit: MEGA_DRIVE_MAX_ROM_BYTES,
        unit: "bytes",
      },
      failure.message,
      "file-size",
    );
  if (failure.ceiling === "smd-blocks")
    return artifactFixedLimitFailure(
      {
        name: "The Mega Drive SMD block ceiling",
        kind: "input",
        limit: MEGA_DRIVE_MAX_SMD_BLOCKS,
        unit: "blocks",
      },
      failure.message,
      "file-size",
    );
  return undefined;
};

const megaDriveRegions = (): RegionDecoding<MegaDriveRom> => ({
  label: "Mega Drive ROM",
  keyPrefix: "mega-drive-rom",
  createDecoder: (fileBytes) => createMegaDriveRomDecoder(fileBytes),
  limitFailure: megaDriveLimitFailure,
  describe: (rom) => ({
    metadata: rom.metadata,
    regions: rom.regions.map((region) => ({
      path: region.path,
      byteOffset: region.fileOffset,
      formatMetadata: region.metadata,
      bytes: region.bytes,
    })),
    coverage: {
      status: rom.complete ? "complete" : "unknown",
      limitations: [...rom.limitations],
    },
  }),
});

/** Inventory a Mega Drive or Genesis ROM, including an SMD copier dump. */
export class MegaDriveRomArtifactReader extends DecodedRegionArtifactReader<MegaDriveRom> {
  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "mega-drive-rom", megaDriveRegions(), admitted);
  }
}
