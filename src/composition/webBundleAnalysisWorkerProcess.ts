import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { serveWebBundleAnalysisWorker } from "../browser/WebBundleAnalysisWorkerServer.js";
import { errorMessage } from "../kernel/errorMessage.js";

try {
  await serveWebBundleAnalysisWorker(analyzeCapturedWebScript);
} catch (cause: unknown) {
  process.stderr.write(`${errorMessage(cause)}\n`);
  process.exitCode = 1;
}
