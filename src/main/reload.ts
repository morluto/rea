import { parseConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { RuntimeDependencies } from "./types.js";
import type { RuntimeState } from "./state.js";

export const registerConfigReload = (input: {
  readonly dependencies: RuntimeDependencies;
  readonly runtimeState: RuntimeState;
  readonly serverLogger: Logger;
}): (() => void) => {
  const { dependencies, runtimeState, serverLogger } = input;
  return (
    dependencies.registerReload?.(() => {
      const refreshed = parseConfig(dependencies.env);
      if (!refreshed.ok) {
        serverLogger.error("Reloaded REA configuration is invalid");
        return;
      }
      runtimeState.currentConfig = refreshed.value;
    }) ?? (() => undefined)
  );
};
