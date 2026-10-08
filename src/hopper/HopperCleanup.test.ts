import { EventEmitter } from "node:events";
import { Socket } from "node:net";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { ok } from "../domain/result.js";
import type { BridgeLaunch } from "./BridgeLauncher.js";
import { cleanupHopperSession } from "./HopperCleanup.js";

const loggerHarness = () => {
  const logs: unknown[] = [];
  return {
    logs,
    logger: pino(
      { level: "warn" },
      {
        write: (line) => logs.push(JSON.parse(line)),
      },
    ),
  };
};

const processCleanupLaunch = (): BridgeLaunch => ({
  process: Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }),
  ownsProcessLifetime: true,
  providerLifetime: "launcher-process",
  shutdownMode: "process-cleanup",
  cleanup: () =>
    Promise.resolve({
      cleaned: false as const,
      reason: "fixture cleanup unavailable",
    }),
});

const failure = (message: string) =>
  Object.assign(new TypeError(message), { code: "ECONNRESET" });

describe("Hopper shutdown rejection diagnostics", () => {
  it("retains the primary shutdown operation and rejection cause", async () => {
    const { logger, logs } = loggerHarness();
    const result = await cleanupHopperSession({
      socket: new Socket(),
      launch: undefined,
      processSupervisor: undefined,
      runtimeRoot: undefined,
      activeRequest: null,
      retainDocument: false,
      progress: undefined,
      logger,
      onDiagnostic: undefined,
      request: () => Promise.reject(failure("fixture primary rejection")),
      releaseTransport: () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { cleanupResources: ["hopper-document"] },
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "Hopper document shutdown was not confirmed",
        status: "failed",
        errorTag: "HopperProcessError",
        operation: "shutdown_document",
        failure_cause: {
          name: "TypeError",
          message: "fixture primary rejection",
          code: "ECONNRESET",
        },
      }),
    );
  });

  it("retains the fallback shutdown operation and rejection cause", async () => {
    const { logger, logs } = loggerHarness();
    const methods: string[] = [];
    const result = await cleanupHopperSession({
      socket: new Socket(),
      launch: processCleanupLaunch(),
      processSupervisor: undefined,
      runtimeRoot: undefined,
      activeRequest: null,
      retainDocument: false,
      progress: undefined,
      logger,
      onDiagnostic: undefined,
      request: (method) => {
        methods.push(method);
        return method === "shutdown"
          ? Promise.resolve(ok({ shutdown: true, cleanup_required: true }))
          : Promise.reject(failure("fixture fallback rejection"));
      },
      releaseTransport: () => undefined,
    });

    expect(methods).toEqual(["shutdown", "shutdown_document"]);
    expect(result).toMatchObject({
      ok: false,
      error: { cleanupResources: ["hopper-document"] },
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "Hopper document shutdown fallback was not confirmed",
        status: "failed",
        errorTag: "HopperProcessError",
        operation: "shutdown_document",
        failure_cause: {
          name: "TypeError",
          message: "fixture fallback rejection",
          code: "ECONNRESET",
        },
      }),
    );
  });
});
