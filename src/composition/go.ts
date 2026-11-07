import { GoBinaryService } from "../application/go/GoBinaryService.js";
import { GoBinaryProvider } from "../go/GoBinaryProvider.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { runtimeGoBuildInfoAdmission } from "../config/runtimeAnalysisSettings.js";

/** Compose bundled offline inspection without acquiring a toolchain or starting any process. */
export const createGoBinaryService = (
  environment: Readonly<NodeJS.ProcessEnv> = {},
  settings?: AnalysisSettingsReader,
): GoBinaryService =>
  new GoBinaryService(
    new GoBinaryProvider(runtimeGoBuildInfoAdmission(environment, settings)),
  );
