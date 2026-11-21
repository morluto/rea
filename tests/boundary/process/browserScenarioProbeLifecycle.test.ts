import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/ports/BrowserScenarioCapturePort.js";
import { createBrowserObservationProvider } from "../../../src/composition/browserObservation.js";
import { createElectronObservationProvider } from "../../../src/composition/electronObservation.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

import { controlledCleanup } from "../../support/lifecycleHarness.js";

const openTransport = async (
  serve: RuntimeDependencies["serve"],
  refuseCleanup = false,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const scenarioFailure = new Error("Scenario cleanup failed");
  const activeFailure = new Error("Fuse preflight cleanup failed");
  const scenario = controlledCleanup({
    refused: refuseCleanup,
    failure: scenarioFailure,
  });
  const active = controlledCleanup({
    refused: refuseCleanup,
    failure: activeFailure,
  });
  const browserObservation = createBrowserObservationProvider();
  const browserClose = vi
    .spyOn(browserObservation, "close")
    .mockResolvedValue(undefined);
  const electronObservation = createElectronObservationProvider({});
  const electronClose = vi
    .spyOn(electronObservation, "close")
    .mockResolvedValue(undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async () => {
      throw new Error("Unexpected scenario capture");
    },
    close: scenario.close,
  };
  const electronActiveObservation = {
    identity: () => ({
      id: "active-electron",
      name: "Active Electron",
      version: "1",
    }),
    capture: async () => {
      throw new Error("Unexpected Electron capture");
    },
    close: active.close,
  };
  const transport = await startMcpTransport(
    {
      env: {},
      serve,
      writeStderr: () => undefined,
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
    },
    session,
    {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: {},
      delivery: createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
      loadOptionalProviders: async () => ({
        browserObservation,
        browserScenarioCapture,
        electronObservation,
        electronActiveObservation,
      }),
    },
  );
  const allowCleanup = () => {
    scenario.allow();
    active.allow();
  };
  return {
    transport,
    allowCleanup,
    failures: [scenarioFailure, activeFailure],
    attempts: () => ({
      browser: browserClose.mock.calls.length,
      scenario: scenario.attempts,
      electron: electronClose.mock.calls.length,
      active: active.attempts,
    }),
    close: async () => {
      allowCleanup();
      try {
        await transport.handle.close();
      } finally {
        await Promise.all([
          transport.closeAndroid(),
          transport.closeOptionalProviders(),
          session.close(),
        ]);
      }
    },
  };
};

it("keeps the shared browser scenario provider open when the SDK discards its discovery probe", async () => {
  let factory: Parameters<RuntimeDependencies["serve"]>[0] | undefined;
  const fixture = await openTransport((create) => {
    factory = create;
    return { close: async () => undefined };
  }, true);
  try {
    const { transport } = fixture;
    if (!transport.ok || factory === undefined)
      throw new Error("Expected SDK server factory after transport startup");
    for (const era of ["modern", "legacy"] as const) {
      const server = await factory({ era });
      await server.close();
      expect(fixture.attempts()).toEqual({
        browser: 0,
        scenario: 0,
        electron: 0,
        active: 0,
      });
    }
    await expect(transport.closeOptionalProviders()).rejects.toMatchObject({
      errors: fixture.failures,
    });
    expect(fixture.attempts()).toEqual({
      browser: 1,
      scenario: 1,
      electron: 1,
      active: 1,
    });

    fixture.allowCleanup();
    await transport.closeOptionalProviders();
    await transport.closeOptionalProviders();
    expect(fixture.attempts()).toEqual({
      browser: 1,
      scenario: 2,
      electron: 1,
      active: 2,
    });
  } finally {
    await fixture.close();
  }
});

it("closes optional providers when MCP server startup throws", async () => {
  const fixture = await openTransport(() => {
    throw new Error("Server startup failed");
  });
  try {
    expect(fixture.transport).toMatchObject({ ok: false, cancelled: false });
    const released = { browser: 1, scenario: 1, electron: 1, active: 1 };
    expect(fixture.attempts()).toEqual(released);
    await fixture.close();
    expect(fixture.attempts()).toEqual(released);
  } finally {
    await fixture.close();
  }
});
