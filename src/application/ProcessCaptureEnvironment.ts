import { delimiter } from "node:path";

import type { ProcessScenario } from "../domain/processCapture.js";
import type { LoopbackReplay } from "./LoopbackReplay.js";
import type { CommandShimReplay } from "./CommandShimReplay.js";

interface ProcessCaptureEnvironmentOptions {
  readonly scenario: ProcessScenario;
  readonly replay: LoopbackReplay;
  readonly shimReplay: CommandShimReplay;
  readonly runId: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
}

/** Build the inherited environment with scenario overrides and replay instrumentation. */
export const makeProcessCaptureEnvironment = (
  options: ProcessCaptureEnvironmentOptions,
): Record<string, string> => {
  const { scenario, replay, shimReplay, runId, hostEnvironment } = options;
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...scenario.environment,
    TERM: scenario.environment.TERM ?? hostEnvironment.TERM ?? "xterm-256color",
    REA_PROCESS_RUN_ID: runId,
  };
  environment.REA_REPLAY_HTTP_URL = replay.httpUrl;
  environment.REA_REPLAY_WEBSOCKET_URL = replay.websocketUrl;
  environment.REA_SHIM_LEDGER_URL = shimReplay.url;
  // Shims are instrumentation; all remaining executable lookup uses host PATH.
  environment.PATH = [shimReplay.binPath, environment.PATH ?? ""]
    .filter((part) => part.length > 0)
    .join(delimiter);
  return environment;
};
