import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("keeps the shared browser scenario provider open when the SDK discards its discovery probe", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const close = vi.fn(async () => undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async () => {
      throw new Error("Unexpected scenario capture");
    },
    close,
  };
  const factories: Parameters<RuntimeDependencies["serve"]>[0][] = [];
  const runtime: RuntimeDependencies = {
    env: {},
    serve: (factory) => {
      factories.push(factory);
      return { close: async () => undefined };
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(runtime, session, {
    logger: silentLogger,
    serverLogger: silentLogger,
    environment: runtime.env,
    delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    loadOptionalProviders: async () => ({ browserScenarioCapture }),
  });
  if (!transport.ok) throw new Error("Transport failed");
  const factory = factories[0];
  if (factory === undefined) throw new Error("Missing SDK server factory");
  try {
    const probe = await factory({ era: "modern" });
    await probe.close();
    const replacement = await factory({ era: "legacy" });
    await replacement.close();
    expect(close).not.toHaveBeenCalled();

    await transport.closeOptionalProviders();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await transport.closeAndroid();
    await session.close();
  }
});
