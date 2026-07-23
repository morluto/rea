import { describe, expect, it } from "vitest";

import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import {
  processCaptureSchema,
  type ProcessCapture,
} from "../src/domain/processCapture.js";
import {
  createProcessObservation,
  projectProcessObservation,
} from "../src/domain/processObservation.js";

const emptyCapture = processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);

const capture: ProcessCapture = {
  ...emptyCapture,
  frames: [{ sequence: 0, at_ms: 1, data: "Ready" }],
  rendered_frames: [
    {
      sequence: 0,
      at_ms: 2,
      columns: 80,
      rows: 24,
      cursor_x: 0,
      cursor_y: 0,
      active_buffer: "normal",
      lines: ["Ready"],
      serialized_state: "Ready",
    },
  ],
  interaction_events: [
    {
      sequence: 0,
      scheduled_at_ms: 2,
      dispatched_at_ms: 3,
      type: "signal",
      data: "SIGINT",
      outcome: "dispatched",
    },
  ],
  process_samples: [
    {
      at_ms: 4,
      pid: 2,
      parent_pid: 1,
      command: "worker",
      process_group_id: 1,
      session_id: 1,
    },
  ],
  shim_events: [
    {
      sequence: 0,
      at_ms: 5,
      command: "helper",
      route_index: 0,
      arguments: [],
      working_directory: "/fixture",
      outcome: "matched",
    },
  ],
  protocol_events: [
    {
      sequence: 0,
      at_ms: 6,
      protocol: "http",
      direction: "request",
      method: "GET",
      path: "/done",
      data: "",
      outcome: "matched",
    },
  ],
  replay_transitions: [
    {
      sequence: 0,
      at_ms: 7,
      transition_id: "done",
      state_before: "open",
      state_after: "closed",
      sensitive_aliases: [],
    },
  ],
};

describe("process observation vocabulary", () => {
  it("projects every capture collection without timestamp sorting", () => {
    const locations = [
      { collection: "frames", index: 0, capture_order: 4 },
      { collection: "rendered_frames", index: 0, capture_order: 3 },
      { collection: "interaction_events", index: 0, capture_order: 2 },
      { collection: "lifecycle", index: 0, capture_order: 8 },
      { collection: "lifecycle", index: 1, capture_order: 9 },
      { collection: "process_samples", index: 0, capture_order: 1 },
      { collection: "filesystem_checkpoints", index: 0, capture_order: 0 },
      { collection: "shim_events", index: 0, capture_order: 5 },
      { collection: "protocol_events", index: 0, capture_order: 6 },
      { collection: "replay_transitions", index: 0, capture_order: 7 },
    ] as const;
    const observations = locations.map((location) =>
      projectProcessObservation(capture, location),
    );

    expect(observations.map((value) => value?.source)).toEqual([
      "terminal_raw",
      "terminal_rendered",
      "interaction",
      "lifecycle",
      "lifecycle",
      "process",
      "filesystem",
      "shim",
      "http",
      "replay_transition",
    ]);
    expect(observations.map((value) => value?.capture_order)).toEqual(
      locations.map(({ capture_order }) => capture_order),
    );
    expect(observations[5]).toMatchObject({
      event_id: "obs.process_samples.0",
      source_sequence: 0,
      captured_at_ms: 4,
      subject_id: "process:2",
    });
    expect(observations[7]).toMatchObject({
      event_id: "obs.shim_events.0",
      subject_id: "shim:helper:route:0",
    });
    expect(observations[3]?.captured_at_ms).toBeNull();
    expect(observations[4]?.captured_at_ms).toBeNull();
  });

  it("uses the same constructor for live and post-hoc observations", () => {
    const location = {
      collection: "frames" as const,
      index: 0,
      capture_order: 4,
    };
    const projected = projectProcessObservation(capture, location);
    const live = createProcessObservation({
      source: "terminal_raw",
      source_sequence: 0,
      captured_at_ms: 1,
      subject_id: null,
      location,
      payload: capture.frames[0],
    });
    expect(live).toEqual(projected);
  });

  it("returns no observation for a missing raw record", () => {
    expect(
      projectProcessObservation(capture, {
        collection: "frames",
        index: 1,
        capture_order: 10,
      }),
    ).toBeNull();
  });
});
