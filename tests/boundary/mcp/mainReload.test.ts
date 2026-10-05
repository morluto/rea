import { describe, expect, it } from "vitest";

import { run } from "../../../src/main.js";
import {
  createServer,
  type CreateServerOptions,
} from "../../../src/server/createServer.js";

type RuntimeDependencies = NonNullable<Parameters<typeof run>[0]>;

describe("runtime configuration reload", () => {
  it("updates runtime executable configuration for connected server factories", async () => {
    const env: NodeJS.ProcessEnv = {
      REA_JAVASCRIPT_REPLAY_NODE_PATH: "/first/node",
      REA_MANAGED_RUNTIME_EXECUTABLE_PATH: "/first/dotnet",
    };
    const runtime = await startRuntime(env);

    expect(runtime.options.javascriptReplayConfiguration?.()).toMatchObject({
      nodePath: "/first/node",
    });
    expect(runtime.options.managedRuntimeConfiguration?.()).toEqual({
      executablePath: "/first/dotnet",
    });

    env.REA_JAVASCRIPT_REPLAY_NODE_PATH = "/second/node";
    env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH = "/second/dotnet";
    runtime.reload();

    expect(runtime.options.javascriptReplayConfiguration?.()).toMatchObject({
      nodePath: "/second/node",
    });
    expect(runtime.options.managedRuntimeConfiguration?.()).toEqual({
      executablePath: "/second/dotnet",
    });
  });

  it("retains the last valid runtime configuration after an invalid reload", async () => {
    const env: NodeJS.ProcessEnv = {
      REA_JAVASCRIPT_REPLAY_NODE_PATH: "/valid/node",
      REA_MANAGED_RUNTIME_EXECUTABLE_PATH: "/valid/dotnet",
    };
    const runtime = await startRuntime(env);

    env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH = "relative/bwrap";
    runtime.reload();

    expect(runtime.options.javascriptReplayConfiguration?.()).toMatchObject({
      nodePath: "/valid/node",
    });
    expect(runtime.options.managedRuntimeConfiguration?.()).toEqual({
      executablePath: "/valid/dotnet",
    });
  });
});

const startRuntime = async (env: NodeJS.ProcessEnv) => {
  let reload: (() => void) | undefined;
  let options: CreateServerOptions | undefined;
  const dependencies: RuntimeDependencies = {
    env,
    serve: (factory) => {
      void factory({ era: "legacy" });
      return { close: () => Promise.resolve() };
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
    registerReload: (handler) => {
      reload = handler;
      return () => undefined;
    },
    createServer: (analysis, session, received) => {
      options = received;
      return createServer(analysis, session, received);
    },
  };

  expect(await run(dependencies)).toBe(0);
  if (reload === undefined || options === undefined)
    throw new Error("Runtime reload seam was not initialized");
  return { reload, options };
};
