import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { parseWebBundleEndpointLiteralAdmission } from "../config/webBundleEndpointLiteralCandidates.js";
import { WEB_BUNDLE_ENDPOINT_LITERAL_SETTING } from "../domain/webBundleEndpointLiteralBudget.js";
import {
  serveWebBundleAnalysisWorker,
  type WebBundleScriptAnalyzer,
} from "../browser/WebBundleAnalysisWorkerServer.js";
import type { WebBundleEndpointLiteralAdmission } from "../domain/webBundleEndpointLiteralBudget.js";

const launchAdmission = parseWebBundleEndpointLiteralAdmission(
  process.env[WEB_BUNDLE_ENDPOINT_LITERAL_SETTING],
);

const analyze: WebBundleScriptAnalyzer = (
  script,
  precision,
  endpointLiterals,
) => {
  const admission = endpointLiterals ?? launchAdmissionOrThrow();
  return analyzeCapturedWebScript(script, precision, admission);
};

const launchAdmissionOrThrow = (): WebBundleEndpointLiteralAdmission => {
  if (!launchAdmission.ok) throw launchAdmission.error;
  return launchAdmission.value;
};

try {
  await serveWebBundleAnalysisWorker(analyze);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
