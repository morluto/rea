import { serveJavaScriptAnalysisWorker } from "../javascript/analysis/JavaScriptAnalysisWorkerServer.js";
import { createJavaScriptSourceWorkerAnalyzer } from "./javascriptAnalysisWorkerAnalyzer.js";

try {
  await serveJavaScriptAnalysisWorker(createJavaScriptSourceWorkerAnalyzer());
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
