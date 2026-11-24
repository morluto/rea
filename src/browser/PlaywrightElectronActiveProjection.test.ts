import { expect, it } from "vitest";

import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";

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

it("keeps main-process IPC gaps distinct from delivery and retention loss", () => {
  const boundaries = [
    "custom-apply",
    "listener-chain",
    "once-metadata",
    "listener-registration",
    "listener-removal",
  ];
  const result = projectElectronActiveCapture(
    { executable: "/opt/electron", application: "/opt/app/main.js" },
    [],
    {
      windows: [],
      metrics: [],
      electronVersion: "test-electron",
      hookSnapshot: {
        events: boundaries.map((boundary, index) => ({
          ...event,
          sequence: index + 1,
          correlation_id: `capture:123:${String(index + 1)}`,
          kind: "ipc-observation-gap",
          event: boundary,
          channel: "custom",
          direction: null,
          receiver: null,
          target: "ipcMain.on",
        })),
        retention_budget_bytes: 16 * 1024 * 1024,
        estimated_retained_bytes: 2_560,
        event_serialized_byte_upper_bound: 512,
        retained: 5,
        dropped: 2,
        dropped_ipc: 0,
        dropped_runtime: 2,
        dropped_event_families: [{ family: "ipc-observation-gap", count: 2 }],
        dropped_event_roles: [{ role: "main", count: 2 }],
        observed: 7,
        observed_ipc: 0,
        observed_runtime: 7,
        hook_error: false,
        single_instance_lock_refused: false,
      },
    },
  );

  expect(result.ipc).toEqual({ events: [], observed: 0, dropped: 0 });
  expect(result.timeline.events).toMatchObject(
    boundaries.map((boundary) => ({
      kind: "ipc-observation-gap",
      event: boundary,
      channel: "custom",
    })),
  );
  expect(result.coverage.status).toBe("partial_attach");
  expect(result.coverage.observed_roles).toEqual(["main"]);
  expect(result.coverage.observed_event_families).toContain(
    "ipc-observation-gap",
  );
  expect(result.coverage.unavailable_event_families).toEqual(
    expect.arrayContaining(["ipc", "renderer-ipc"]),
  );
  expect(result.retention.dropped).toBe(2);
  expect(result.limitations).toContainEqual(
    expect.stringContaining("unobserved callback arguments and execution"),
  );
  expect(result.limitations).not.toContain(
    "The active IPC hook could not be installed.",
  );
});

it("projects hook retention and dropped event families through the result schema", () => {
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
        dropped: 2,
        dropped_ipc: 1,
        dropped_runtime: 1,
        dropped_event_families: [
          { family: "renderer-ipc", count: 1 },
          { family: "preload-configuration", count: 1 },
        ],
        dropped_event_roles: [{ role: "renderer", count: 1 }],
        observed: 3,
        observed_ipc: 2,
        observed_runtime: 1,
        hook_error: false,
        single_instance_lock_refused: false,
      },
    },
  );

  expect(result.retention).toMatchObject({
    budget_bytes: 16 * 1024 * 1024,
    estimated_retained_bytes: 1_024,
    event_serialized_byte_upper_bound: 512,
    retained: 1,
    dropped: 2,
    dropped_event_families: [
      { family: "renderer-ipc", count: 1 },
      { family: "preload-configuration", count: 1 },
    ],
    dropped_event_roles: [{ role: "renderer", count: 1 }],
  });
  expect(result.ipc).toEqual({ events: [event], observed: 2, dropped: 1 });
  expect(result.timeline).toMatchObject({ observed: 3, dropped: 2 });
  expect(result.coverage.observed_event_families).toContain("renderer-ipc");
  expect(result.coverage.unavailable_event_families).not.toContain(
    "renderer-ipc",
  );
  expect(result.coverage.observed_roles).toContain("renderer");
  expect(result.coverage.observed_event_families).toContain(
    "preload-configuration",
  );
  expect(result.coverage.unavailable_event_families).not.toContain(
    "preload-configuration",
  );
  expect(result.limitations.join("\n")).not.toContain(
    "Preload configuration was not exposed",
  );
});

it("does not correlate legacy dropped families and roles", () => {
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
        events: [],
        retention_budget_bytes: 16 * 1024 * 1024,
        estimated_retained_bytes: 0,
        event_serialized_byte_upper_bound: 0,
        retained: 0,
        dropped: 2,
        dropped_ipc: 1,
        dropped_runtime: 1,
        dropped_event_families: [
          { family: "preload", count: 1 },
          { family: "renderer-ipc", count: 1 },
        ],
        dropped_event_roles: [
          { role: "browser", count: 1 },
          { role: "renderer", count: 1 },
        ],
        observed: 2,
        observed_ipc: 1,
        observed_runtime: 1,
        hook_error: false,
        single_instance_lock_refused: false,
      },
    },
  );

  expect(result.coverage.observed_event_families).toContain("preload");
  expect(result.coverage.observed_event_families).not.toContain(
    "preload-configuration",
  );
  expect(result.coverage.unavailable_event_families).toContain(
    "preload-configuration",
  );
  expect(result.coverage.observed_roles).toEqual(["browser", "renderer"]);
  expect(result.retention.dropped_event_families).toEqual([
    { family: "preload", count: 1 },
    { family: "renderer-ipc", count: 1 },
  ]);
  const limitations = result.limitations.join("\n");
  expect(limitations).toContain("Dropped preload-family events");
  expect(limitations).toContain("not attributed to preload configuration");
  expect(limitations).toContain(
    "independently aggregated event families and roles",
  );
  expect(limitations).toContain("cannot establish that relationship");
});
