import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import type { WebBundleAnalysisAdmission } from "../browser/IsolatedWebBundleAnalyzer.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createBrowserObservationProvider = (
  admission?: WebBundleAnalysisAdmission,
  environment?: Readonly<Record<string, string | undefined>>,
  settings?: AnalysisSettingsReader,
): BrowserObservationPort =>
  new CdpBrowserProvider(admission, environment, settings);
