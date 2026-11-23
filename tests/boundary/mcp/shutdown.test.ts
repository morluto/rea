import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { expect, it } from "vitest";

import { createManagedBinarySession } from "../../../src/composition/binary.js";
import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { createShutdown } from "../../../src/main/shutdown.js";
import {
  OwnedDebuggerCleanupError,
  retainedDebuggerRemediation,
} from "../../../src/process/ownedDebuggerCleanupError.js";
import { registerProcessShutdown } from "../../../src/main/processShutdown.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { err, ok } from "../../../src/domain/result.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { phaseGate, settledCause } from "../../support/lifecycleHarness.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("reports ordinary and retained debugger shutdown failures at their owning boundary", async () => {
  const retained = new OwnedDebuggerCleanupError(
    [new Error("detach unverified")],
    "One or more owned GDB processes did not stop cleanly",
    [4242],
  );
  const cases = [
    {
      failure: Object.assign(new TypeError("fixture transport close failed"), {
        code: "ECONNRESET",
      }),
      stderr: [`${MCP_SHUTDOWN_FAILED}\n`],
      failureCause: {
        name: "TypeError",
        message: "fixture transport close failed",
        code: "ECONNRESET",
      },
    },
    {
      failure: new AggregateError(
        [new AggregateError([retained], "REA provider cleanup failed")],
        "REA server cleanup failed",
      ),
      stderr: [
        `${MCP_SHUTDOWN_FAILED}\n`,
        `${retainedDebuggerRemediation([4242])}\n`,
      ],
      failureCause: expect.objectContaining({
        errors: [
          expect.objectContaining({
            errors: [
              expect.objectContaining({ retained_debugger_pids: [4242] }),
            ],
          }),
        ],
      }),
    },
  ];
  for (const scenario of cases) {
    const logs: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const lifecycle = createShutdown({
      handle: {
        close: async () => {
          throw scenario.failure;
        },
      },
      session: createManagedBinarySession(),
      dependencies: {
        ...idleShutdownDependencies(),
        writeStderr: (text) => output.push(text),
        setExitCode: (code) => exitCodes.push(code),
      },
      serverLogger: pino(
        { level: "debug" },
        { write: (line) => logs.push(line) },
      ),
    });
    lifecycle.request();
    await expect(lifecycle.shutdown()).rejects.toBe(scenario.failure);
    expect(exitCodes).toEqual([1]);
    expect(output).toEqual(scenario.stderr);
    const entries = logs.map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 20,
        msg: "MCP shutdown rejected",
        failure_cause: scenario.failureCause,
      }),
    );
    if (scenario.failure instanceof AggregateError) {
      expect(output[1]).toMatch(/\b4242\b/u);
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: 50,
          msg: MCP_SHUTDOWN_FAILED,
          retained_debugger_pids: [4242],
        }),
      );
    }
  }
});

it("reports a typed binary cleanup failure and retains the client for retry", async () => {
  const [target] = await createBinarySessionTargets();
  const failure = new ProviderCleanupError("fixture", ["owned-runtime"], {
    reason: "fixture removal denied",
  });
  let cleanupAllowed = false;
  let retainDocument: boolean | undefined;
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close: async (options) => {
      retainDocument = options?.retainDocument;
      return cleanupAllowed ? ok(null) : err(failure);
    },
  }));
  expect((await session.open(target)).ok).toBe(true);
  const output: string[] = [];
  const exitCodes: number[] = [];
  const lifecycle = createShutdown({
    handle: { close: async () => undefined },
    session,
    dependencies: {
      ...idleShutdownDependencies(),
      writeStderr: (text) => output.push(text),
      setExitCode: (code) => exitCodes.push(code),
    },
    serverLogger: pino({ enabled: false }),
  });
  lifecycle.request();
  await expect(lifecycle.shutdown()).rejects.toBe(failure);
  expect(exitCodes).toEqual([1]);
  expect(output).toEqual([
    `${MCP_SHUTDOWN_FAILED}\n`,
    `${failure.userMessage}\n`,
  ]);
  expect(retainDocument).toBe(true);
  cleanupAllowed = true;
  await lifecycle.shutdown();
  expect(session.activeTarget()).toBeUndefined();
});

it("joins stdin and signal shutdown, retaining investigation history until retry succeeds", async () => {
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const transport = phaseGate();
  const logs: string[] = [];
  const exitCode = createDeferred<number>();
  const unregistered = createDeferred<void>();
  let unregisterCount = 0;
  let handleCalls = 0;
  let androidCalls = 0;
  let optionalCalls = 0;
  let sessionCalls = 0;
  const dependencies: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("unused fixture transport");
    },
    writeStderr: () => undefined,
    setExitCode: exitCode.resolve,
    registerShutdown: (request) => {
      const unregister = registerProcessShutdown(request, { signals, stdin });
      return () => {
        unregister();
        unregisterCount += 1;
        unregistered.resolve();
      };
    },
  };
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close: async () => {
      sessionCalls += 1;
      return ok(null);
    },
  }));
  const [target] = await createBinarySessionTargets();
  if (target === undefined) throw new Error("Missing fixture target");
  expect((await session.open(target)).ok).toBe(true);
  expect(
    (
      await session.execute("address_name", {
        address: "0x1000",
        document: "fixture",
      })
    ).ok,
  ).toBe(true);
  expect(
    session.recordEvidence(
      createEvidence(
        unknownTarget("not-observed"),
        {
          id: "fixture",
          name: "Shutdown fixture",
          version: "1",
        },
        {
          operation: "retained_shutdown_fact",
          parameters: {},
          result: "owned observation",
        },
      ),
    ).ok,
  ).toBe(true);
  const unknown = session.recordUnknown({
    question: "Did every runtime cleanup owner finish?",
    severity: "medium",
    domain: "lifecycle",
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  });
  if (!unknown.ok) throw unknown.error;
  const retained = session.exportEvidenceBundle();
  const lifecycle = createShutdown({
    handle: {
      close: async () => {
        handleCalls += 1;
        if (handleCalls === 1) await transport.hold();
      },
    },
    closeAndroid: async () => {
      androidCalls += 1;
      if (androidCalls === 1) throw new Error("first Android close failed");
    },
    closeOptionalProviders: async () => {
      optionalCalls += 1;
    },
    session,
    dependencies,
    serverLogger: pino(
      { level: "debug" },
      { write: (line) => logs.push(line) },
    ),
  });

  try {
    expect(stdin.emit("end")).toBe(true);
    await transport.reached(exitCode.promise, "transport cleanup");
    expect(signals.emit("SIGTERM")).toBe(true);
    const first = settledCause(lifecycle.shutdown());
    const concurrent = settledCause(lifecycle.shutdown());
    transport.reject(new Error("first handle close failed"));
    const failure = await first;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(await concurrent).toBe(failure);
    const causes = [
      { message: "first handle close failed" },
      { message: "first Android close failed" },
    ];
    expect(failure).toMatchObject({ errors: causes });
    expect(await exitCode.promise).toBe(1);
    const rejectionLog = logs
      .map((line) => JSON.parse(line))
      .find((log) => log.msg === "MCP shutdown rejected");
    expect(rejectionLog).toMatchObject({ failure_cause: { errors: causes } });
    expect([
      handleCalls,
      androidCalls,
      optionalCalls,
      sessionCalls,
      unregisterCount,
    ]).toEqual([1, 1, 1, 1, 0]);
    expect(session.activeTarget()).toBeUndefined();
    expect(session.exportEvidenceBundle()).toEqual(retained);
    expect(session.listUnknowns()).toEqual([unknown.value]);

    expect(signals.emit("SIGTERM")).toBe(true);
    await unregistered.promise;
    expect(signals.emit("SIGINT")).toBe(false);
    expect(signals.emit("SIGTERM")).toBe(false);
    expect(stdin.emit("end")).toBe(false);
    expect(stdin.emit("close")).toBe(false);
    expect([
      handleCalls,
      androidCalls,
      optionalCalls,
      sessionCalls,
      unregisterCount,
    ]).toEqual([2, 2, 1, 1, 1]);
    expect(session.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
    expect(session.listUnknowns()).toEqual([]);
  } finally {
    transport.release();
    await settledCause(lifecycle.shutdown());
  }
});

const idleShutdownDependencies = (): RuntimeDependencies => ({
  env: {},
  serve: () => {
    throw new Error("unused fixture transport");
  },
  writeStderr: () => undefined,
  setExitCode: () => undefined,
  registerShutdown: () => () => undefined,
});

it("reopens after ordinary close and seals new acquisitions throughout shutdown", async () => {
  const [target] = await createBinarySessionTargets();
  if (target === undefined) throw new Error("Missing fixture target");
  const providerHealth = phaseGate();
  const transport = phaseGate();
  let created = 0;
  let closed = 0;
  const session = createTestBinarySession(() => {
    const reopening = ++created === 2;
    return {
      execute: async (operation) => {
        if (operation === "health" && reopening) await providerHealth.hold();
        return observed(null);
      },
      close: async () => {
        closed += 1;
        return ok(null);
      },
    };
  });
  const lifecycle = createShutdown({
    handle: {
      prepareShutdown: () => transport.hold(),
      close: async () => undefined,
    },
    session,
    dependencies: idleShutdownDependencies(),
    serverLogger: pino({ enabled: false }),
  });
  const expectAcquisitionRefused = async () => {
    const [binary, resources] = await Promise.all([
      session.open(target),
      session.openBundleResources(target),
    ]);
    expect(binary).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
    expect(resources).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "open_bundle_resources",
      },
    });
  };

  try {
    expect((await session.open(target)).ok).toBe(true);
    expect((await session.close()).ok).toBe(true);
    expect(session.activeTarget()).toBeUndefined();

    const opening = session.open(target);
    await providerHealth.reached(
      opening,
      "provider health after ordinary close",
    );
    const closing = lifecycle.shutdown();
    await transport.reached(closing, "transport shutdown preparation");
    const acquisition = expectAcquisitionRefused();
    providerHealth.release();
    const [opened] = await Promise.all([opening, acquisition]);
    expect(opened).toMatchObject({ ok: true });
    expect(session.activeTarget()?.path).toBe(target);

    transport.release();
    await closing;
    await expectAcquisitionRefused();
    expect(session.activeTarget()).toBeUndefined();
    expect(await session.status()).toMatchObject({ open: false });
    expect([created, closed]).toEqual([2, 2]);
  } finally {
    providerHealth.release();
    transport.release();
    await settledCause(lifecycle.shutdown());
  }
});
