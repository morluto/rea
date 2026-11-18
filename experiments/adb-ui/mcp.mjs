// Unshipped proposal entrypoint. The installed CLI/server never imports this file.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { run } from "../../dist/main.js";
import { registerProcessShutdown } from "../../dist/main/processShutdown.js";
import { createServer } from "../../dist/server/createServer.js";
import { createAdbDeviceAnalysisProvider } from "../../dist/composition/adb.js";
import { AdbDeviceAnalysisService } from "../../dist/application/adb/AdbDeviceAnalysisService.js";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../dist/contracts/adb/adbUiToolContracts.js";
import { createEvidenceToolHandler } from "../../dist/server/contractToolHandler.js";
import { toolRegistrationOptions } from "../../dist/server/toolRegistrationOptions.js";
import { createLogger } from "../../dist/logger.js";

process.exitCode = await run({
  env: process.env,
  serve: serveStdio,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: registerProcessShutdown,
  createServer: (source, options) => {
    const recordEvidence =
      source.kind === "session"
        ? (evidence) => source.session.recordEvidence(evidence)
        : undefined;
    const provider = createAdbDeviceAnalysisProvider(
      options?.environment,
      undefined,
      (evidence) => {
        const recorded = recordEvidence?.(evidence);
        if (recorded !== undefined && !recorded.ok) throw recorded.error;
      },
    );
    const server = createServer(source, {
      ...options,
      adbDeviceAnalysis: provider,
    });
    const contract = PROPOSED_ADB_UI_ACTION_CONTRACT;
    const service = new AdbDeviceAnalysisService(provider);
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      createEvidenceToolHandler(
        server,
        (input, executionOptions) =>
          service.execute(contract.name, input, executionOptions),
        options?.logger ?? createLogger("mcp", "silent"),
        recordEvidence,
      )(contract),
    );
    return server;
  },
});
