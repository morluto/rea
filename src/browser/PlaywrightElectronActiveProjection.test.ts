import { expect, it } from "vitest";

import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";

it("projects hook retention and dropped event families through the result schema", () => {
  const event = {
    sequence: 1,
    correlation_id: "capture:123:1",
    kind: "main-handler-invocation" as const,
    event: null,
    phase: "observed" as const,
    channel: "readiness:echo",
    direction: "renderer-to-main" as const,
    sender: null,
    receiver: "main",
    frame: null,
    target: null,
    argument_shapes: [],
    result_shape: null,
    process_type: "main",
    source: "electron-active-hook",
    capture_method: "api-wrapper" as const,
    artifact_path: null,
    artifact_sha256: null,
    error: false,
  };
  const result = projectElectronActiveCapture(
    {
      executable: "/opt/electron",
      application: "/opt/app/main.js",
    },
    [],
    {
      windows: [],
      metrics: [],
      electronVersion: "test-electron",
      hookSnapshot: {
        events: [event],
        retention_budget_bytes: 16 * 1024 * 1024,
        estimated_retained_bytes: 1_024,
        event_serialized_byte_upper_bound: 512,
        retained: 1,
        dropped: 1,
        dropped_ipc: 0,
        dropped_runtime: 1,
        dropped_event_families: [{ family: "renderer-ipc", count: 1 }],
        dropped_event_roles: [{ role: "renderer", count: 1 }],
        observed: 2,
        observed_ipc: 1,
        observed_runtime: 1,
        hook_error: false,
      },
    },
  );

  expect(result.retention).toMatchObject({
    budget_bytes: 16 * 1024 * 1024,
    estimated_retained_bytes: 1_024,
    event_serialized_byte_upper_bound: 512,
    retained: 1,
    dropped: 1,
    dropped_event_families: [{ family: "renderer-ipc", count: 1 }],
    dropped_event_roles: [{ role: "renderer", count: 1 }],
  });
  expect(result.ipc).toMatchObject({ observed: 1, dropped: 0 });
  expect(result.timeline).toMatchObject({ observed: 2, dropped: 1 });
  expect(result.coverage.observed_event_families).toContain("renderer-ipc");
  expect(result.coverage.unavailable_event_families).not.toContain(
    "renderer-ipc",
  );
  expect(result.coverage.observed_roles).toContain("renderer");
  expect(result.coverage.unavailable_event_families).toContain("preload");
});

it("keeps renderer coverage unavailable when only the main process was observed", () => {
  const result = projectElectronActiveCapture(
    {
      executable: "/opt/electron",
      application: "/opt/app/main.js",
    },
    [],
    {
      windows: [],
      metrics: [],
      electronVersion: "test-electron",
      hookSnapshot: {
        events: [
          {
            sequence: 1,
            correlation_id: "capture:123:1",
            kind: "app-lifecycle",
            event: "ready",
            phase: "observed",
            channel: null,
            direction: null,
            sender: null,
            receiver: null,
            frame: null,
            target: "app",
            argument_shapes: [],
            result_shape: null,
            process_type: "main",
            source: "electron-active-hook",
            capture_method: "event-emitter",
            artifact_path: null,
            artifact_sha256: null,
            error: false,
          },
        ],
        retention_budget_bytes: 16 * 1024 * 1024,
        estimated_retained_bytes: 0,
        event_serialized_byte_upper_bound: 0,
        retained: 1,
        dropped: 0,
        dropped_ipc: 0,
        dropped_runtime: 0,
        dropped_event_families: [],
        dropped_event_roles: [],
        observed: 1,
        observed_ipc: 0,
        observed_runtime: 1,
        hook_error: false,
      },
    },
  );

  expect(result.coverage.observed_roles).not.toContain("renderer");
  expect(result.coverage.unavailable_event_families).toContain("renderer-ipc");
});
