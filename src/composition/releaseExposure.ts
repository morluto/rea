import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { runtimeAsarHeaderAdmission } from "../config/runtimeAnalysisSettings.js";
import { ReleaseExposureReader } from "../artifacts/ReleaseExposureReader.js";
import { ReleaseExposureService } from "../application/releaseExposure/ReleaseExposureService.js";
import { createDesktopApplicationService } from "./desktop.js";
import { createElectronFuseService } from "./electronFuses.js";
import { createGoBinaryService } from "./go.js";
import { createRustBinaryService } from "./rust.js";

/**
 * Compose the read-only release-exposure audit. The reader admits ASAR
 * headers under the shared REA_ASAR_MAX_HEADER_BYTES and runtime
 * asar.max_header_bytes admission, like every other ASAR owner.
 */
export const createReleaseExposureService = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  settings?: AnalysisSettingsReader,
): ReleaseExposureService =>
  new ReleaseExposureService({
    reader: new ReleaseExposureReader(
      runtimeAsarHeaderAdmission(environment, settings),
    ),
    electronFuses: createElectronFuseService(),
    desktop: createDesktopApplicationService(),
    goBinaries: createGoBinaryService(),
    rustBinaries: createRustBinaryService(),
  });
