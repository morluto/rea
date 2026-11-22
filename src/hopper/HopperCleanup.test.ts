import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

import { EventEmitter } from "node:events";
import { Socket } from "node:net";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { HopperProcessError } from "./HopperErrors.js";
import { err, ok } from "../domain/result.js";
import { observeProcessStartIdentity } from "../process/ProcessOwnershipObservation.js";
import type { BridgeLaunch } from "./BridgeLauncher.js";
import {
  cleanupHopperSession,
  confirmExternalApplicationExit,
  type HopperOwnedResources,
} from "./HopperCleanup.js";
import { ArtifactResourceScope } from "../resources/index.js";

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

const externalApplicationResources = (): HopperOwnedResources => ({
  launch: {
    process: Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }),
    ownsProcessLifetime: false,
    providerLifetime: "external-application",
    shutdownMode: "bridge-request",
  },
  processSupervisor: undefined,
  runtimeRoot: undefined,
  shutdownConfirmed: false,
  inspections: new ArtifactResourceScope(),
  externalApplication: {
    pid: 123,
    identity: { state: "readable", identity: "captured-start" },
  },
});

it.each(["throw", "reject"] as const)(
  "releases owned runtime and lease when cleanup progress observers %s",
  async (failureMode) => {
    const parent = await createTestTempDirectory(
      "rea-hopper-progress-cleanup-",
    );
    const runtimeRoot = await PrivateRuntimeRoot.create({ parent });
    const backingPath = join(runtimeRoot.path, "image.macho");
    await writeFile(backingPath, "owned backing bytes");
    const resources = externalApplicationResources();
    const releaseLease = vi.fn(async () => undefined);
    resources.externalApplication = undefined;
    resources.runtimeRoot = runtimeRoot;
    resources.launch = {
      ...resources.launch!,
      preparedImagePath: backingPath,
      releaseLease,
    };
    const request = vi.fn(async () =>
      ok({ shutdown: true, analysis_stopped: true, document_closed: true }),
    );
    try {
      const result = await cleanupHopperSession({
        socket: new Socket(),
        resources,
        activeRequest: null,
        retainDocument: false,
        progress: {
          report: () => {
            const cause = new Error("observer failed");
            if (failureMode === "throw") throw cause;
            return Promise.reject(cause);
          },
        },
        logger: loggerHarness().logger,
        onDiagnostic: undefined,
        request,
        releaseTransport: () => undefined,
      });
      expect(result).toEqual(ok(null));
      expect(request).toHaveBeenCalledExactlyOnceWith("shutdown_document");
      await expect(access(backingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(resources.runtimeRoot).toBeUndefined();
      expect(resources.launch).toBeUndefined();
    } finally {
      await runtimeRoot.close();
    }
  },
);

describe("external Hopper process exit confirmation", () => {
  it("confirms only the captured GUI process exit and releases its transport", async () => {
    const resources = externalApplicationResources();
    const released: unknown[] = [];
    const observeExit = vi.fn().mockResolvedValue("exited");
    await confirmExternalApplicationExit(
      resources,
      undefined,
      (socket) => released.push(socket),
      observeExit,
    );
    expect(observeExit).toHaveBeenCalledWith(123, "captured-start");
    expect(resources.shutdownConfirmed).toBe(true);
    expect(released).toEqual([undefined]);
  });

  it.each(["exiting", "present", "unverified"] as const)(
    "does not confirm an external application while its exact identity is %s",
    async (observation) => {
      const resources = externalApplicationResources();
      const releaseTransport = vi.fn();
      await confirmExternalApplicationExit(
        resources,
        undefined,
        releaseTransport,
        async () => observation,
      );
      expect(resources.shutdownConfirmed).toBe(false);
      expect(releaseTransport).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "names the failed shutdown request and the live application it retains",
    async () => {
      // This test process is a live, exactly identified application.
      const identity = await observeProcessStartIdentity(process.pid);
      if (identity?.state !== "readable")
        throw new Error("Expected a readable identity for the test process");
      const resources = externalApplicationResources();
      resources.externalApplication = { pid: process.pid, identity };
      const result = await cleanupHopperSession({
        socket: new Socket(),
        resources,
        activeRequest: null,
        retainDocument: false,
        progress: undefined,
        logger: loggerHarness().logger,
        onDiagnostic: undefined,
        request: async (method) =>
          err(
            new HopperProcessError(null, {
              operation: method,
              providerState: "unreachable",
            }),
          ),
        releaseTransport: () => undefined,
      });
      if (result.ok)
        throw new Error("Expected the live application to be kept");
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: {
          diagnostics: {
            issues: [
              {
                resource: "hopper-document",
                reason:
                  "authenticated shutdown acknowledgement was not observed",
              },
            ],
            authenticated_application: "readable",
            shutdown_request: {
              method: "shutdown_document",
              status: "failed",
              error_tag: "HopperProcessError",
              provider_state: "unreachable",
            },
            application_exit: "present",
          },
        },
      });
    },
  );
});

describe("Hopper shutdown rejection diagnostics", () => {
  it("retains the primary shutdown operation and rejection cause", async () => {
    const { logger, logs } = loggerHarness();
    const result = await cleanupHopperSession({
      socket: new Socket(),
      resources: {
        launch: undefined,
        processSupervisor: undefined,
        runtimeRoot: undefined,
        shutdownConfirmed: false,
        inspections: new ArtifactResourceScope(),
        externalApplication: undefined,
      },
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
      resources: {
        launch: processCleanupLaunch(),
        processSupervisor: undefined,
        runtimeRoot: undefined,
        shutdownConfirmed: false,
        inspections: new ArtifactResourceScope(),
        externalApplication: undefined,
      },
      activeRequest: null,
      retainDocument: false,
      progress: undefined,
      logger,
      onDiagnostic: undefined,
      request: (method) => {
        methods.push(method);
        return method === "shutdown"
          ? Promise.resolve(
              ok({
                shutdown: true,
                analysis_stopped: true,
                document_closed: false,
                cleanup_required: true,
              }),
            )
          : Promise.reject(failure("fixture fallback rejection"));
      },
      releaseTransport: () => undefined,
    });

    expect(methods).toEqual(["shutdown", "shutdown_document"]);
    expect(result).toMatchObject({
      ok: false,
      error: { cleanupResources: ["hopper-document"] },
    });
    if (result.ok) throw new Error("Expected the document to be retained");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: {
        diagnostics: {
          shutdown_request: {
            method: "shutdown",
            status: "unconfirmed",
            fallback: {
              method: "shutdown_document",
              status: "failed",
              error_tag: "HopperProcessError",
            },
          },
        },
      },
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

// The reply lacks analysis_stopped, so it is outside the shutdown contract.
const offContract = { shutdown: true, document_closed: true };
it.each([
  {
    stage: "primary",
    launch: { ...processCleanupLaunch(), shutdownMode: "bridge-request" },
    reply: (method: string) =>
      method === "shutdown_document" ? offContract : undefined,
    methods: ["shutdown_document"],
    message: "Hopper document shutdown was not confirmed",
    diagnostics: { method: "shutdown_document", status: "unconfirmed" },
  },
  {
    stage: "fallback",
    launch: processCleanupLaunch(),
    reply: (method: string) =>
      method === "shutdown"
        ? {
            shutdown: true,
            analysis_stopped: true,
            document_closed: false,
            cleanup_required: true,
          }
        : offContract,
    methods: ["shutdown", "shutdown_document"],
    message: "Hopper document shutdown fallback was not confirmed",
    diagnostics: {
      method: "shutdown",
      status: "unconfirmed",
      fallback: { method: "shutdown_document", status: "unconfirmed" },
    },
  },
] as const)(
  "retains the document and names the contract issues of an off-contract $stage reply",
  async ({ launch, reply, methods, message, diagnostics }) => {
    const { logger, logs } = loggerHarness();
    const requested: string[] = [];
    const result = await cleanupHopperSession({
      socket: new Socket(),
      resources: {
        launch,
        processSupervisor: undefined,
        runtimeRoot: undefined,
        shutdownConfirmed: false,
        inspections: new ArtifactResourceScope(),
        externalApplication: undefined,
      },
      activeRequest: null,
      retainDocument: false,
      progress: undefined,
      logger,
      onDiagnostic: undefined,
      request: (method) => {
        requested.push(method);
        return Promise.resolve(ok(reply(method) ?? null));
      },
      releaseTransport: () => undefined,
    });

    expect(requested).toEqual(methods);
    expect(result).toMatchObject({
      ok: false,
      error: { cleanupResources: ["hopper-document"] },
    });
    if (result.ok) throw new Error("Expected the document to be retained");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: { diagnostics: { shutdown_request: diagnostics } },
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: message,
        status: "invalid-acknowledgement",
        reply_contract: expect.objectContaining({
          contract_issues: [
            expect.objectContaining({ path: ["analysis_stopped"] }),
          ],
        }),
      }),
    );
  },
);

it("keeps a prepared backing image when native document closure cannot be confirmed", async () => {
  const parent = await createTestTempDirectory("rea-hopper-backing-lifetime-");
  const runtimeRoot = await PrivateRuntimeRoot.create({ parent });
  const preparedImagePath = join(runtimeRoot.path, "image.macho");
  await writeFile(preparedImagePath, "owned backing bytes");
  const { logger } = loggerHarness();
  try {
    const launch = {
      ...processCleanupLaunch(),
      preparedImagePath,
      shutdownMode: "bridge-request" as const,
      providerLifetime: "external-application" as const,
    };
    const result = await cleanupHopperSession({
      socket: new Socket(),
      resources: {
        launch,
        runtimeRoot,
        processSupervisor: undefined,
        shutdownConfirmed: false,
        inspections: new ArtifactResourceScope(),
        externalApplication: undefined,
      },
      activeRequest: null,
      retainDocument: true,
      progress: undefined,
      logger,
      onDiagnostic: undefined,
      request: () => Promise.reject(failure("document closure unobserved")),
      releaseTransport: () => undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupResources: expect.arrayContaining([
          "hopper-document",
          runtimeRoot.path,
        ]),
      },
    });
    await expect(access(preparedImagePath)).resolves.toBeUndefined();
  } finally {
    await runtimeRoot.close();
    await rm(parent, { recursive: true, force: true });
  }
});
