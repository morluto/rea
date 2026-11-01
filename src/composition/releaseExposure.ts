import { ReleaseExposureReader } from "../artifacts/ReleaseExposureReader.js";
import { ReleaseExposureService } from "../application/releaseExposure/ReleaseExposureService.js";
import { createDesktopApplicationService } from "./desktop.js";
import { createElectronFuseService } from "./electronFuses.js";
import { createGoBinaryService } from "./go.js";
import { createRustBinaryService } from "./rust.js";

/** Compose the read-only release-exposure audit. */
export const createReleaseExposureService = (): ReleaseExposureService =>
  new ReleaseExposureService({
    reader: new ReleaseExposureReader(),
    electronFuses: createElectronFuseService(),
    desktop: createDesktopApplicationService(),
    goBinaries: createGoBinaryService(),
    rustBinaries: createRustBinaryService(),
  });
