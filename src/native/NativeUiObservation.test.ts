import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { observeNativeUi } from "./NativeUiObservation.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";

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

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
  "base64",
);
describe("native UI screenshot validation", () => {
  it("rejects malformed or mismatched screenshot bytes from the helper", async () => {
    const screenshot = {
      mime_type: "image/png",
      base64: validPng.toString("base64"),
      sha256: "0".repeat(64),
      width: 1,
      height: 1,
    };
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, screenshot: true },
      {
        invoke: async () => ({
          ok: true,
          result: { ...snapshot, screenshot },
        }),
      },
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    { base64: "%%%=" },
    { base64: Buffer.from("not a PNG").toString("base64") },
    { width: 2 },
    { sha256: "0".repeat(64) },
  ])(
    "rejects invalid screenshot field variants from the helper",
    async (change) => {
      const screenshot = {
        mime_type: "image/png",
        base64: validPng.toString("base64"),
        sha256: createHash("sha256").update(validPng).digest("hex"),
        width: 1,
        height: 1,
        ...change,
      };
      const result = await observeNativeUi(
        target,
        "observe_native_ui",
        { ...scope, screenshot: true },
        {
          invoke: async () => ({
            ok: true,
            result: { ...snapshot, screenshot },
          }),
        },
      );
      expect(result.ok).toBe(false);
    },
  );

  it("accepts a self-consistent PNG screenshot from the helper", async () => {
    const bytes = validPng;
    const screenshot = {
      mime_type: "image/png",
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 1,
      height: 1,
    };
    const result = await observeNativeUi(
      target,
      "observe_native_ui",
      { ...scope, screenshot: true },
      {
        invoke: async () => ({
          ok: true,
          result: { ...snapshot, screenshot },
        }),
      },
    );
    expect(result.ok).toBe(true);
  });
});

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
      { invoke },
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
      { invoke },
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
        signal: controller.signal,
        invoke: async () => {
          controller.abort();
          return { ok: true, result: snapshot };
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.steps[0]).toMatchObject({
        kind: "wait",
        outcome: "cancelled",
      });
  });
});

describe("native UI target and cancellation failures", () => {
  it.each([
    "accessibility-denied",
    "screen-recording-denied",
    "ambiguous-window",
  ])("preserves actionable %s without fallback", async (code) => {
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      invoke: async () => ({
        ok: false,
        code,
        message: "Grant permission or select an unambiguous window",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(code);
  });
  it("preserves the underlying helper failure reason in diagnostics", async () => {
    const result = await observeNativeUi(target, "observe_native_ui", scope, {
      invoke: async () => {
        throw new Error(
          "Native helper returned invalid JSON: Unexpected token",
        );
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      diagnostics: {
        reason: "Native helper returned invalid JSON: Unexpected token",
        remediation:
          "Native helper failed, timed out, or returned malformed capture data; install compatible Xcode command-line tools and inspect local OS permissions",
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
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.steps).toMatchObject([
        { index: 0, outcome: "failed", before: snapshot, after: null },
      ]);
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
        signal: controller.signal,
        invoke: async () => {
          calls++;
          controller.abort();
          return { ok: true, result: snapshot };
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.steps[0]?.outcome).toBe("cancelled");
    const replaced = await observeNativeUi(target, "observe_native_ui", scope, {
      invoke: async () => ({
        ok: true,
        result: { ...snapshot, window: { ...snapshot.window, pid: 999 } },
      }),
    });
    expect(replaced.ok).toBe(false);
  });
});
