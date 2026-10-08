import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import { MITMPROXY_CAPTURE_PROVIDER_IDENTITY } from "./CaptureRelease.js";
const OPERATION = "inspect_web_network_capture";

/** Native mitmproxy decoding is offline and uses only an explicitly configured Linux tool. */
export class MitmproxyCaptureAdapter implements HistoricalCaptureFormatAdapter {
  readonly format = "mitmproxy";
  readonly identity = MITMPROXY_CAPTURE_PROVIDER_IDENTITY;
  constructor(readonly environment: Readonly<NodeJS.ProcessEnv>) {}
  async command(
    requestPath: string,
    runtimePath: string,
  ): Promise<{ command: string; arguments: readonly string[] }> {
    const command = this.environment.REA_MITMDUMP_COMMAND;
    if (
      process.platform !== "linux" ||
      command === undefined ||
      !isAbsolute(command)
    )
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        "Native capture decoding requires Linux and an absolute REA_MITMDUMP_COMMAND path to caller-supplied mitmdump 12.2.3; HAR needs no external engine.",
      );
    try {
      await access(command, constants.R_OK | constants.X_OK);
    } catch (cause: unknown) {
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        `Configured mitmdump executable is unavailable: ${command}.`,
        { cause },
      );
    }
    return {
      command,
      arguments: [
        "--no-server",
        "-q",
        "--set",
        `confdir=${runtimePath}`,
        "--set",
        `rea_request_path=${requestPath}`,
        "-s",
        fileURLToPath(
          new URL("../../../bridge/mitmproxy/capture.py", import.meta.url),
        ),
      ],
    };
  }
}
