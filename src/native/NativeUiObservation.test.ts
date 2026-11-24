import { createHash } from "node:crypto";
import { malformedInput } from "../domain/parseFailure.js";
import { crc32 } from "node:zlib";

import { describe, expect, it, vi } from "vitest";
import { observeNativeUi, type NativeUiHelper } from "./NativeUiObservation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ExecFileOutputCancelledError } from "../process/ExecFileOutput.js";
import { AnalysisCleanupLease } from "../resources/AnalysisCleanupLease.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

const target: BinaryTarget = {
  path: "/fixture/App",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};
const scope = {
  pid: 123,
  window_id: 456,
  screenshot: false,
};
const snapshot = {
  window: {
    pid: 123,
    window_id: 456,
    executable: target.path,
    launch_time: 1,
    title: "Fixture",
  },
  nodes: [],
  screenshot: null,
  gaps: [],
  truncated: false,
};

const runtimeWith = (signal: AbortSignal, invoke: NativeUiHelper) => {
  const cleanupLease = new AnalysisCleanupLease(async () => undefined);
  return {
    signal,
    deadlineMs: 180_000,
    invoke,
    cleanupLease,
    close: () => cleanupLease.release(),
    resources: () => [],
  };
};

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
  "base64",
);

/** Screenshot payload as the native helper reports one PNG buffer. */
const screenshotOf = (bytes: Buffer) => ({
  mime_type: "image/png",
  base64: bytes.toString("base64"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

/** Observe the fixture snapshot carrying one screenshot payload. */
const observeWithScreenshot = (screenshot: Record<string, unknown>) =>
  observeNativeUi(
    target,
    "observe_native_ui",
    { ...scope, screenshot: true },
    {
      environment: {},
      invoke: async () => ({ ok: true, result: { ...snapshot, screenshot } }),
    },
  );

it.each([
  { offset: 8, value: 12 },
  { offset: 16, value: 0x8000_0000 },
  { offset: 20, value: 0x8000_0000 },
])(
  "rejects invalid IHDR metadata with a matching digest",
  async ({ offset, value }) => {
    const bytes = Buffer.from(validPng);
    bytes.writeUInt32BE(value, offset);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    const result = await observeWithScreenshot(screenshotOf(bytes));
    expect(result.ok).toBe(false);
  },
);
describe("native UI screenshot validation", () => {
  it.each([24, 32, "crc", "invalid filter"])(
    "rejects incomplete or corrupt IHDR despite matching native digest: %s",
    async (kind) => {
      const bytes = Buffer.from(validPng);
      if (kind === "crc") bytes[29] = (bytes[29] ?? 0) ^ 1;
      if (kind === "invalid filter") {
        bytes[27] = 1;
        bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
      }
      const payload =
        typeof kind === "number" ? bytes.subarray(0, kind) : bytes;
      expect((await observeWithScreenshot(screenshotOf(payload))).ok).toBe(
        false,
      );
    },
  );
  it("rejects malformed or mismatched screenshot bytes from the helper", async () => {
    const result = await observeWithScreenshot({
      ...screenshotOf(validPng),
      sha256: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    { base64: "%%%=" },
    { base64: Buffer.from("not a PNG").toString("base64") },
    { width: 2 },
  ])(
    "rejects invalid screenshot field variants from the helper",
    async (change) => {
      const result = await observeWithScreenshot({
        ...screenshotOf(validPng),
        ...change,
      });
      expect(result.ok).toBe(false);
    },
  );

  it("rejects a PNG whose IHDR type only matches after ASCII folding", async () => {
    const bytes = Buffer.from(validPng);
    const type = bytes.subarray(12, 16);
    type[0] = (type[0] ?? 0) | 0x80;
    expect(type.toString("ascii")).toBe("IHDR");
    const result = await observeWithScreenshot(screenshotOf(bytes));
    expect(result.ok).toBe(false);
  });

  it("accepts a self-consistent PNG screenshot from the helper", async () => {
    const result = await observeWithScreenshot(screenshotOf(validPng));
    expect(result.ok).toBe(true);
  });

  it("preserves an unknown AX child count and its truncation gap", async () => {
    const partial = {
      ...snapshot,
      nodes: [
        {
          path: [],
          role: "AXWindow",
          title: "Fixture",
          value: null,
          actions: [],
          children_count: null,
        },
      ],
      truncated: true,
      gaps: ["AX child count unavailable at path []: AXError -25204"],
    };
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, accessibility: true },
      { environment: {}, invoke: async () => ({ ok: true, result: partial }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.initial).toMatchObject({
        truncated: true,
        gaps: ["AX child count unavailable at path []: AXError -25204"],
        nodes: [{ children_count: null }],
      });
  });

  it("retains incomplete action observations and their gap", async () => {
    const partial = {
      ...snapshot,
      nodes: [
        {
          path: [],
          role: "AXWindow",
          title: null,
          value: null,
          actions: [],
          children_count: 0,
        },
      ],
      truncated: true,
      gaps: [
        "AX actions unavailable at path []: AXError -25204",
        "AX value unavailable at path []: AXError -25204",
      ],
    };
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, accessibility: true },
      { environment: {}, invoke: async () => ({ ok: true, result: partial }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.initial.truncated).toBe(true);
      expect(result.value.initial.gaps).toEqual(partial.gaps);
      expect(result.value.initial.nodes[0]?.actions).toEqual([]);
    }
  });
});

it.each(["observe_native_ui", "capture_native_ui_scenario"] as const)(
  "keeps the rejected capture mode reason and field corrections for %s",
  async (operation) => {
    const result = await observeNativeUi(
      target,
      operation,
      {
        pid: 123,
        window_id: 456,
        screenshot: false,
        accessibility: false,
        ...(operation === "capture_native_ui_scenario"
          ? { steps: [{ kind: "wait", milliseconds: 0 }] }
          : {}),
      },
      {
        environment: {},
        invoke: async () => {
          throw new Error("No native helper should run for this refusal");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected capture mode refusal");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          { path: ["screenshot"], reason: "invalid_value" },
          { path: ["accessibility"], reason: "invalid_value" },
        ],
      },
    });
    expect(projected.message).toMatch(/screenshot.*accessibility/iu);
    expect(projected.remediation.action).toMatch(/screenshot.*accessibility/iu);
    expect(projected.remediation.action).toMatch(/true/iu);
  },
);

describe("native UI capture selection and budgets", () => {
  it("accepts observations and scenarios without compatibility flags", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      return { ok: true, result: snapshot };
    };
    const observed = await observeNativeUi(
      target,
      "observe_native_ui",
      { pid: 123, window_id: 456, screenshot: false, accessibility: true },
      { environment: {}, invoke },
    );
    expect(observed.ok).toBe(true);
    const captured = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        pid: 123,
        window_id: 456,
        screenshot: false,
        accessibility: true,
        steps: [{ kind: "click", path: [] }],
      },
      { environment: {}, invoke },
    );
    expect(captured.ok).toBe(true);
    expect(calls).toBe(3);
  });
  it("returns caller-selected large observations and complete action lists", async () => {
    const nodeLimits: unknown[] = [];
    const steps = Array.from({ length: 17 }, () => ({
      kind: "wait" as const,
      milliseconds: 0,
    }));
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        pid: 123,
        window_id: 456,
        screenshot: false,
        accessibility: true,
        max_nodes: 2_001,
        steps,
      },
      {
        environment: {},
        invoke: async (parameters) => {
          nodeLimits.push(parameters.max_nodes);
          return { ok: true, result: snapshot };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(nodeLimits).toEqual(Array.from({ length: 18 }, () => 2_001));
    if (result.ok) {
      expect(result.value.steps).toHaveLength(17);
      expect(
        result.value.steps.every(({ outcome }) => outcome === "completed"),
      ).toBe(true);
    }
  });
  it("accepts caller-selected waits beyond the old aggregate cutoff", async () => {
    const controller = new AbortController();
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        pid: 123,
        window_id: 456,
        screenshot: false,
        accessibility: true,
        steps: Array.from({ length: 4 }, () => ({
          kind: "wait" as const,
          milliseconds: 10_001,
        })),
      },
      {
        environment: {},
        signal: controller.signal,
        invoke: async () => {
          controller.abort();
          return { ok: true, result: snapshot };
        },
      },
    );
    if (result.ok) throw new Error("Expected scenario cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(controller.signal.reason);
    expect(result.error.partialObservation).toMatchObject({
      initial: snapshot,
      steps: [{ kind: "wait", outcome: "cancelled" }],
    });
  });
  it("reports aggregate output exhaustion after individually valid captures", async () => {
    const largeSnapshot = {
      ...snapshot,
      window: { ...snapshot.window, title: "x".repeat(17 * 1024 * 1024) },
    };
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        ...scope,
        steps: [{ kind: "wait", milliseconds: 0 }],
      },
      {
        environment: {},
        invoke: async () => ({ ok: true, result: largeSnapshot }),
      },
    );
    if (result.ok) throw new Error("Expected scenario output limit failure");
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.partialObservation).toMatchObject({
      initial: largeSnapshot,
      steps: [
        {
          outcome: "failed",
          reason: expect.stringContaining("64 MiB output budget"),
        },
      ],
    });
  });
});

describe("native UI deadline execution", () => {
  it.each([undefined, 2_500])(
    "reports the operation deadline %s independently of the wait-step cap",
    async (deadlineMs) => {
      const passive = deadlineMs === undefined;
      const result = await observeNativeUi(
        target,
        passive ? "observe_native_ui" : "capture_native_ui_scenario",
        passive
          ? scope
          : {
              ...scope,
              native_ui_deadline_ms: deadlineMs,
              steps: [{ kind: "wait", milliseconds: 0 }],
            },
        {
          environment: {},
          invoke: async () => ({ ok: true, result: snapshot }),
        },
      );
      if (!result.ok) throw result.error;
      const limitation = result.value.limitations.join("\n");
      expect(limitation).toMatch(
        new RegExp(
          `native_ui_deadline_ms.*${String(deadlineMs ?? 180_000)} ms.*omitted.*180000`,
          "iu",
        ),
      );
      expect(limitation).toMatch(
        /wait step.*capped at 180000 ms.*no runtime override/iu,
      );
    },
  );

  it("enforces the selected owned deadline and retains the completed capture", async () => {
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, native_ui_deadline_ms: 1 },
      {
        environment: {},
        invoke: async (_parameters, signal) => {
          if (signal === undefined) throw new Error("Missing owned signal");
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { ok: true, result: snapshot };
        },
      },
    );
    if (result.ok) throw new Error("Expected selected owned deadline");
    expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
    expect(result.error).toMatchObject({
      timeoutMs: 1,
      partialObservation: { initial: snapshot },
    });
  });

  it.each([
    ["owned deadline", AnalysisTimeoutError],
    ["independent producer cancellation", AnalysisCancelledError],
  ] as const)(
    "preserves %s from the helper during deadline expiry",
    async (source, ErrorType) => {
      const deadline = new AbortController();
      const deadlineReason = new DOMException(
        "deadline elapsed",
        "TimeoutError",
      );
      const reason =
        source === "owned deadline" ? deadlineReason : { phase: "producer" };
      const result = await observeNativeUi(target, "observe_native_ui", scope, {
        environment: {},
        runtime: runtimeWith(deadline.signal, async () => {
          deadline.abort(deadlineReason);
          throw new ExecFileOutputCancelledError(reason);
        }),
      });
      if (result.ok) throw new Error("Expected helper interruption");
      expect(result.error).toBeInstanceOf(ErrorType);
      expect(result.error.cause).toBe(reason);
    },
  );

  it.each(["click", "wait"] as const)(
    "keeps deadline expiry at a scenario %s as a failed step",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const deadline = new AbortController();
      const reason = { phase: "scenario-deadline" };
      const step =
        kind === "click" ? { kind, path: [1] } : { kind, milliseconds: 100 };
      const invoke = vi.fn(async () => {
        if (kind === "click") deadline.abort(reason);
        return { ok: true, result: snapshot };
      });
      const pending = observeNativeUi(
        target,
        "capture_native_ui_scenario",
        { ...scope, steps: [step] },
        { environment: {}, runtime: runtimeWith(deadline.signal, invoke) },
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      try {
        await vi.advanceTimersByTimeAsync(0);
        if (kind === "wait") {
          expect(invoke).toHaveBeenCalledOnce();
          expect(settled).toBe(false);
          deadline.abort(reason);
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toBe(true);
        }
        const result = await pending;
        if (result.ok) throw new Error("Expected deadline timeout");
        expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
        expect(result.error.cause).toBe(reason);
        expect(result.error.partialObservation).toMatchObject({
          initial: snapshot,
          steps: [{ kind, outcome: "failed", before: snapshot, after: null }],
        });
        expect(invoke).toHaveBeenCalledOnce();
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
        await pending;
      }
    },
  );
});

it.each([false, true])(
  "classifies a helper subprocess timeout, preserving an earlier caller abort: %s",
  async (callerFirst) => {
    const caller = new AbortController();
    const reason = { phase: "caller" };
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, native_ui_deadline_ms: 2_500 },
      {
        environment: {},
        signal: caller.signal,
        invoke: async () => {
          if (callerFirst) caller.abort(reason);
          throw Object.assign(new Error("helper subprocess timed out"), {
            code: "ETIMEDOUT",
          });
        },
      },
    );
    if (result.ok) throw new Error("Expected helper interruption");
    const projected = projectAnalysisError(result.error);
    if (callerFirst) {
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(projected.code).toBe("cancelled");
    } else {
      expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
      expect(projected).toMatchObject({
        code: "provider_timeout",
        details: {
          timeout_ms: 2_500,
          limit: {
            control_kind: "parameter",
            parameter: "native_ui_deadline_ms",
            effective_value: 2_500,
            default_value: 180_000,
          },
        },
      });
    }
  },
);

describe("native UI interruption provenance", () => {
  it("treats a caller TimeoutError-shaped reason as caller cancellation", async () => {
    const caller = new AbortController();
    const reason = new DOMException("caller stopped", "TimeoutError");
    caller.abort(reason);
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      signal: caller.signal,
      invoke: async () => ({ ok: true, result: snapshot }),
    });
    if (result.ok) throw new Error("Expected caller cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
  });

  it("preserves a physical helper failure even if the owned deadline fires", async () => {
    const deadline = new AbortController();
    const failure = new Error("physical helper failure");
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      runtime: runtimeWith(deadline.signal, async () => {
        deadline.abort({ phase: "late-deadline" });
        throw failure;
      }),
    });
    if (result.ok) throw new Error("Expected helper failure");
    expect(result.error._tag).toBe("ProviderAdapterError");
    expect(result.error.cause).toBe(failure);
  });

  it("preserves schema failure even if the owned deadline fires", async () => {
    const deadline = new AbortController();
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      runtime: runtimeWith(deadline.signal, async () => {
        deadline.abort({ phase: "late-deadline" });
        return { ok: true, result: { malformed: true } };
      }),
    });
    if (result.ok) throw new Error("Expected schema failure");
    expect(result.error._tag).toBe("ProviderAdapterError");
    expect(result.error.cause).toMatchObject({ name: "ZodError" });
  });
});

describe("native UI target and cancellation failures", () => {
  it.each([
    "accessibility-denied",
    "accessibility-unavailable",
    "screen-recording-denied",
    "ambiguous-window",
  ])("preserves actionable %s without fallback", async (code) => {
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      invoke: async () => ({
        ok: false,
        code,
        message: "Grant permission or select an unambiguous window",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.message).toBe(
        "Grant permission or select an unambiguous window",
      );
      if (code === "ambiguous-window")
        expect(projected).toMatchObject({
          code: "invalid_request",
          details: {
            issues: [
              { path: ["window_id"], message: expect.stringContaining(code) },
            ],
          },
        });
      else {
        expect(projected.code).toBe("capability_unavailable");
        expect(projected.details?.reason).toContain(code);
      }
    }
  });
  it("preserves the underlying helper failure reason in diagnostics", async () => {
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      invoke: async () => {
        // The helper runtime's own report of output that is not JSON.
        throw malformedInput(
          "native-ui-helper-output",
          "Native helper returned invalid JSON: Unexpected token",
        );
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      diagnostics: {
        reason: "Native helper returned invalid JSON: Unexpected token",
        remediation: expect.stringMatching(
          /Xcode command.line tools.*local OS permissions/iu,
        ),
      },
    });
  });
  it("stops on a failed action and returns ordered before/capture-gap evidence", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        ...scope,
        steps: [
          { kind: "scroll", path: [1], direction: "increment" },
          { kind: "click", path: [2] },
        ],
      },
      {
        environment: {},
        invoke: async (parameters) => {
          calls.push(parameters);
          return calls.length === 1
            ? { ok: true, result: snapshot }
            : {
                ok: false,
                code: "action-failed",
                message: "AXIncrement unsupported",
              };
        },
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      launch_time: 1,
      action: { kind: "scroll", path: [1] },
    });
    if (result.ok) throw new Error("Expected failed action");
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.partialObservation).toMatchObject({
      initial: snapshot,
      steps: [{ index: 0, outcome: "failed", before: snapshot, after: null }],
    });
  });
  it("rejects target replacement and stops subsequent actions after cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        ...scope,
        steps: [
          { kind: "wait", milliseconds: 1000 },
          { kind: "click", path: [] },
        ],
      },
      {
        environment: {},
        signal: controller.signal,
        invoke: async () => {
          calls++;
          controller.abort();
          return { ok: true, result: snapshot };
        },
      },
    );
    expect(calls).toBe(1);
    if (result.ok) throw new Error("Expected scenario cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(controller.signal.reason);
    expect(result.error.partialObservation).toMatchObject({
      initial: snapshot,
      steps: [{ outcome: "cancelled" }],
    });
    const replaced = await observeNativeUi(target, "observe_native_ui", scope, {
      environment: {},
      invoke: async () => ({
        ok: true,
        result: { ...snapshot, window: { ...snapshot.window, pid: 999 } },
      }),
    });
    expect(replaced.ok).toBe(false);
  });
});
