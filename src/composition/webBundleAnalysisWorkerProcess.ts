import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { parseWebBundleEndpointLiteralAdmission } from "../config/webBundleEndpointLiteralCandidates.js";
import { WEB_BUNDLE_ENDPOINT_LITERAL_SETTING } from "../domain/webBundleEndpointLiteralBudget.js";
import {
  serveWebBundleAnalysisWorker,
  type WebBundleScriptAnalyzer,
} from "../browser/WebBundleAnalysisWorkerServer.js";

const endpointLiterals = parseWebBundleEndpointLiteralAdmission(
  process.env[WEB_BUNDLE_ENDPOINT_LITERAL_SETTING],
);
if (!endpointLiterals.ok) throw endpointLiterals.error;

const analyze: WebBundleScriptAnalyzer = (script, precision) =>
  analyzeCapturedWebScript(script, precision, endpointLiterals.value);

try {
  await serveWebBundleAnalysisWorker(analyze);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
