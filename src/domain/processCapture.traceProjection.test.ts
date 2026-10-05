import { expect, it } from "vitest";

import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyProcessCapture as emptyCapture,
} from "./processCapture.fixture.js";

it("detects changes in normalized process sample metadata", () => {
  const capture = {
    manifest: emptyCapture().manifest,
    settlement: emptyCapture().settlement,
    normalization: {
      paths: true,
      pids: true,
      ports: true,
      time_bucket_ms: 10,
      patterns: [],
    },
    frames: [],
    rendered_frames: [],
    interaction_events: [],
    exit: { code: 0, signal: null, reason: "exited" as const },
    process_samples: [
      {
        at_ms: 10,
        pid: 1,
        parent_pid: 0,
        process_group_id: 1,
        session_id: 1,
        command: "worker",
      },
    ],
    filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
    files_before: [],
    files_after: [],
    filesystem_effects: [],
    truncated: false,
    limitations: [],
    residual_unknowns: [],
    cleanup: {
      owned_process_group: "verified" as const,
      temporary_root: "removed" as const,
    },
  };
  const changed = {
    ...capture,
    process_samples: [
      {
        at_ms: 20,
        pid: 1,
        parent_pid: 2,
        process_group_id: 1,
        session_id: 1,
        command: "worker",
      },
    ],
  };

  const comparison = compareProcessCaptures(capture, changed);
  expect(comparison.process).toBe("changed");
  expect(comparison.status).toBe("changed");
});
