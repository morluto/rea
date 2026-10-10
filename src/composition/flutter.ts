import type { FlutterBuildAnalysisPort } from "../application/flutter/FlutterBuildAnalysisPort.js";
import { FlutterBuildProvider } from "../flutter/FlutterBuildProvider.js";

/** Construct one Flutter provider; it needs no external tools. */
export const createFlutterBuildAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FlutterBuildAnalysisPort => new FlutterBuildProvider({ environment });
