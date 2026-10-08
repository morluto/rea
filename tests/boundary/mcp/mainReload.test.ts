import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../src/config.js";
import { silentLogger } from "../../../src/logger.js";
import { registerConfigReload } from "../../../src/main/reload.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { createRuntimeState } from "../../../src/main/state.js";

describe("runtime configuration reload", () => {
  it("applies valid reloads and keeps the last valid config after an invalid reload", () => {
    const env: NodeJS.ProcessEnv = { REA_LOG_LEVEL: "info" };
    const runtime = setupReload(env);

    env.REA_LOG_LEVEL = "debug";
    runtime.reload();

    expect(runtime.state.currentConfig.logLevel).toBe("debug");

    env.REA_LOG_LEVEL = "invalid";
    runtime.reload();

    expect(runtime.state.currentConfig.logLevel).toBe("debug");
  });
});

const setupReload = (env: NodeJS.ProcessEnv) => {
  const parsed = parseConfig(env);
  if (!parsed.ok) throw parsed.error;
  const state = createRuntimeState(parsed.value);
  let reload: (() => void) | undefined;
  const dependencies: RuntimeDependencies = {
    env,
    serve: serveStdio,
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
    registerReload: (handler) => {
      reload = handler;
      return () => undefined;
    },
  };
  registerConfigReload({
    dependencies,
    runtimeState: state,
    serverLogger: silentLogger,
  });
  if (reload === undefined)
    throw new Error("Reload handler was not registered");
  return { reload, state };
};
