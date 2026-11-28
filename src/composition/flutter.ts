import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type { FlutterRequest } from "../domain/flutter/flutterBuildAnalysis.js";
import { FlutterBuildProvider } from "../flutter/FlutterBuildProvider.js";

/** Construct one Flutter provider; it needs no external tools. */
export const createFlutterBuildAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  settings?: AnalysisSettingsReader,
): RequestAnalysisPort<FlutterRequest> =>
  new FlutterBuildProvider(environment, settings);
