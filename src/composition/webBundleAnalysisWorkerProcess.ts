import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { serveWebBundleAnalysisWorker } from "../browser/WebBundleAnalysisWorkerServer.js";

try {
  await serveWebBundleAnalysisWorker(analyzeCapturedWebScript);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
