import type { BrowserObservationPort } from "../ports/BrowserObservationPort.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import type { WebBundleAnalysisAdmission } from "../browser/IsolatedWebBundleAnalyzer.js";
import { resolveJavaScriptMemberMutationAllowance } from "../config/javascriptMemberMutationAllowance.js";
import { runtimeWebBundleEndpointLiteralAdmission } from "../config/webBundleEndpointLiteralCandidates.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";

/**
 * Construct a fresh provider without opening a target or acquiring an engine.
 * Bundle analysis reads the member-mutation allowance from the accepted
 * operation's settings and the launch environment when it starts.
 */
export const createBrowserObservationProvider = (
  admission?: WebBundleAnalysisAdmission,
  environment?: Readonly<Record<string, string | undefined>>,
  settings?: AnalysisSettingsReader,
): BrowserObservationPort =>
  new CdpBrowserProvider(
    admission,
    () =>
      resolveJavaScriptMemberMutationAllowance(
        environment,
        settings?.().overrides,
      ),
    () =>
      runtimeWebBundleEndpointLiteralAdmission(
        environment ?? process.env,
        settings,
      ),
  );
