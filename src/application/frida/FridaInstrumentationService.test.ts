import { expect, it } from "vitest";

import type { FridaInstrumentationPort } from "./FridaInstrumentationPort.js";
import { FridaInstrumentationService } from "./FridaInstrumentationService.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const createSession = () => ({
  sessionId: "00000000-0000-4000-8000-000000000001",
  deviceId: "local",
  target: "fixture",
  pid: 10,
  mode: "spawn" as const,
  state: "paused" as const,
});

const createProvider = (
  overrides: Partial<FridaInstrumentationPort> = {},
): FridaInstrumentationPort => ({
  async listDevices() {
    return { ok: true, value: { devices: [], cleanupError: null } };
  },
  async listProcesses() {
    return {
      ok: true,
      value: { deviceId: "local", processes: [], cleanupError: null },
    };
  },
  async startSession() {
    return { ok: true, value: createSession() };
  },
  async loadScript() {
    return {
      ok: true,
      value: {
        scriptId: "00000000-0000-4000-8000-000000000002",
        sourceKind: "inline",
        sourcePath: null,
        sourceSha256: "a".repeat(64),
        messages: [],
        messagesTruncated: false,
      },
    };
  },
  async resumeSession() {
    return { ok: true, value: null };
  },
  async unloadScript() {
    return { ok: true, value: null };
  },
  status() {
    return undefined;
  },
  async closeSession() {
    return { ok: true, value: null };
  },
  async closeAll() {},
  ...overrides,
});

it.each(["startSession", "instrument"] as const)(
  "does not start Frida when %s receives an already-cancelled signal",
  async (method) => {
    let starts = 0;
    let loads = 0;
    const provider = createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
      async loadScript() {
        loads += 1;
        return {
          ok: true,
          value: {
            scriptId: "00000000-0000-4000-8000-000000000002",
            sourceKind: "inline",
            sourcePath: null,
            sourceSha256: "a".repeat(64),
            messages: [],
            messagesTruncated: false,
          },
        };
      },
    });
    const service = new FridaInstrumentationService(provider);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before call"));

    const result =
      method === "startSession"
        ? await service.startSession(
            { mode: "spawn", deviceId: "local", program: "/tmp/fixture" },
            controller.signal,
          )
        : await service.instrument(
            {
              mode: "spawn",
              deviceId: "local",
              program: "/tmp/fixture",
              source: { sourceKind: "inline", source: "send('ready');" },
              durationMs: 1,
            },
            controller.signal,
          );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(starts).toBe(0);
    expect(loads).toBe(0);
  },
);

it("does not resume a spawned target when cancellation arrives during script loading", async () => {
  const controller = new AbortController();
  let resumes = 0;
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled while loading"));
        return {
          ok: true,
          value: {
            scriptId: "00000000-0000-4000-8000-000000000002",
            sourceKind: "inline",
            sourcePath: null,
            sourceSha256: "a".repeat(64),
            messages: [],
            messagesTruncated: false,
          },
        };
      },
      async resumeSession() {
        resumes += 1;
        return { ok: true, value: null };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: null };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 1,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        cleanup_error: null,
        target_resume_observed: false,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        mode: "spawn",
        program: "/tmp/fixture",
      },
    });
  }
  expect(resumes).toBe(0);
  expect(closes).toBe(1);
});

it("reports the spawned session when cancellation arrives during resume", async () => {
  const controller = new AbortController();
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async resumeSession() {
        controller.abort(new Error("cancelled while resuming"));
        return { ok: true, value: null };
      },
      status() {
        return {
          ...createSession(),
          state: "running",
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: null };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      argv: ["--owned-fixture"],
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 60_000,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_resume_observed: true,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        argv: ["--owned-fixture"],
      },
    });
  }
  expect(closes).toBe(1);
});

it("records target selection in Evidence without remote authentication values", async () => {
  const token = "synthetic-frida-token";
  const certificate = "synthetic-frida-certificate";
  const service = new FridaInstrumentationService(createProvider());

  const result = await service.instrument({
    mode: "spawn",
    remote: {
      address: "127.0.0.1:27042",
      token,
      certificate,
      origin: "rea-test",
      keepaliveInterval: 1_000,
    },
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.evidence.parameters).toMatchObject({
    session_id: createSession().sessionId,
    remote: {
      address: "127.0.0.1:27042",
      origin: "rea-test",
      keepalive_interval: 1_000,
    },
    mode: "spawn",
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
  });
  const parameters = JSON.stringify(result.value.evidence.parameters);
  expect(parameters).not.toContain(token);
  expect(parameters).not.toContain(certificate);
});

it("reports completed cleanup when closing the parent session releases a failed script", async () => {
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        return {
          ok: false,
          error: new AnalysisCapabilityUnavailableError(
            "frida",
            "load_frida_script",
            "script load failed",
            {
              cleanup: {
                reason: "script unload failed",
                resources: ["script-1"],
              },
            },
          ),
        };
      },
    }),
  );

  const result = await service.instrument({
    mode: "spawn",
    deviceId: "local",
    program: "/tmp/fixture",
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.cleanupIncomplete).toBe(false);
});

it("cleans up a session and returns typed cancellation after a pending start", async () => {
  let finishStart: (() => void) | undefined;
  let markStartCalled: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const startCalled = new Promise<void>((resolve) => {
    markStartCalled = resolve;
  });
  const closed: string[] = [];
  const provider: FridaInstrumentationPort = {
    async listDevices() {
      return { ok: true, value: { devices: [], cleanupError: null } };
    },
    async listProcesses() {
      return {
        ok: true,
        value: { deviceId: "local", processes: [], cleanupError: null },
      };
    },
    async startSession() {
      markStartCalled?.();
      await startGate;
      return {
        ok: true,
        value: {
          sessionId: "00000000-0000-4000-8000-000000000001",
          deviceId: "local",
          target: "fixture",
          pid: 10,
          mode: "attach",
          state: "running",
        },
      };
    },
    async loadScript() {
      return {
        ok: false,
        error: new AnalysisInputError("load_frida_script"),
      };
    },
    async resumeSession() {
      return { ok: true, value: null };
    },
    async unloadScript() {
      return { ok: true, value: null };
    },
    status() {
      return undefined;
    },
    async closeSession(sessionId) {
      closed.push(sessionId);
      return { ok: true, value: null };
    },
    async closeAll() {},
  };
  const service = new FridaInstrumentationService(provider);
  const controller = new AbortController();
  const pending = service.startSession(
    { mode: "attach", deviceId: "local", pid: 10 },
    controller.signal,
  );
  await startCalled;
  controller.abort(new Error("caller cancelled"));
  finishStart?.();

  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(closed).toEqual(["00000000-0000-4000-8000-000000000001"]);
});
