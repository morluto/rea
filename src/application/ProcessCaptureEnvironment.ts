import type { ProcessScenario } from "../domain/processCapture.js";
import type { LoopbackReplay } from "./LoopbackReplay.js";
import type { CommandShimReplay } from "./CommandShimReplay.js";

interface ProcessCaptureEnvironmentOptions {
  readonly scenario: ProcessScenario;
  readonly home: string;
  readonly replay: LoopbackReplay;
  readonly shimReplay: CommandShimReplay;
  readonly runId: string;
}

/** Build the explicitly admitted environment for a captured process. */
export const makeProcessCaptureEnvironment = (
  options: ProcessCaptureEnvironmentOptions,
): Record<string, string> => {
  const { scenario, home, replay, shimReplay, runId } = options;
  const environment: Record<string, string> = {
    ...scenario.environment,
    HOME: home,
    TERM: "xterm-256color",
    REA_PROCESS_RUN_ID: runId,
  };
  for (const name of scenario.inherit_environment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.REA_REPLAY_HTTP_URL = replay.httpUrl;
  environment.REA_REPLAY_WEBSOCKET_URL = replay.websocketUrl;
  environment.REA_SHIM_LEDGER_URL = shimReplay.url;
  // PATH is evidence-producing input. Inheriting the host PATH here would let
  // the authority and reconstruction probe different tools without recording
  // that difference. Scenarios must opt in through environment or
  // inherit_environment; deterministic shims always take precedence.
  environment.PATH = [shimReplay.binPath, environment.PATH ?? ""]
    .filter((part) => part.length > 0)
    .join(":");
  return environment;
};
