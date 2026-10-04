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
  observation_approved: true,
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
describe("native UI authority and lifecycle", () => {
  it("requires observation and independent action approval before invoking a helper", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      return { ok: true, result: snapshot };
    };
    expect(
      (
        await observeNativeUi(
          target,
          "observe_native_ui",
          { ...scope, observation_approved: false },
          { invoke },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await observeNativeUi(
          target,
          "capture_native_ui_scenario",
          {
            ...scope,
            restore: "leave-as-is",
            steps: [{ kind: "click", path: [] }],
          },
          { invoke },
        )
      ).ok,
    ).toBe(false);
    expect(calls).toBe(0);
  });
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
  it("stops on a failed action and returns ordered before/capture-gap evidence", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const result = await observeNativeUi(
      target,
      "capture_native_ui_scenario",
      {
        ...scope,
        actions_approved: true,
        restore: "leave-as-is",
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
        actions_approved: true,
        restore: "leave-as-is",
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
