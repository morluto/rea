import { expect, it } from "vitest";

import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyProcessCapture as emptyCapture,
} from "./processCapture.fixture.js";

it("distinguishes added evidence from unknown observations", () => {
  const capture = emptyCapture();
  const added = compareProcessCaptures(capture, {
    ...capture,
    frames: [{ sequence: 0, at_ms: 0, data: "new" }],
    rendered_frames: [
      {
        sequence: 0,
        at_ms: 0,
        columns: 3,
        rows: 1,
        cursor_x: 3,
        cursor_y: 0,
        active_buffer: "normal",
        lines: ["new"],
        serialized_state: "new",
      },
    ],
  });
  expect(added).toMatchObject({ terminal: "added", status: "changed" });

  for (const [scope, dimension] of [
    ["process", "process"],
    ["interaction", "interaction"],
  ] as const) {
    expect(
      compareProcessCaptures(
        {
          ...capture,
          residual_unknowns: [{ scope, reason: "observation was partial" }],
        },
        capture,
      ),
    ).toMatchObject({
      status: "unknown",
      [dimension]: "unknown",
      terminal: "unchanged",
    });
  }
});

it("compares raw terminal and process observations while honoring normalization shape", () => {
  const capture = emptyCapture();
  expect(
    compareProcessCaptures(capture, {
      ...capture,
      normalization: {
        patterns: [],
        time_bucket_ms: 10,
        ports: true,
        pids: true,
        paths: true,
      },
    }),
  ).toMatchObject({
    status: "unchanged",
    first_divergence: { status: "none" },
  });

  const terminal = compareProcessCaptures(
    { ...capture, frames: [{ sequence: 0, at_ms: 0, data: "bar" }] },
    { ...capture, frames: [{ sequence: 0, at_ms: 0, data: "foo\rbar" }] },
  );
  expect(terminal).toMatchObject({
    terminal: "changed",
    first_divergence: { status: "found", dimension: "terminal" },
  });

  expect(
    compareProcessCaptures(
      {
        ...capture,
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
      },
      {
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
      },
    ),
  ).toMatchObject({ process: "changed", status: "changed" });
});

it("keeps filesystem comparison unknown without coverage and reports observed changes", () => {
  const capture = emptyCapture();
  const incomplete = {
    ...capture,
    residual_unknowns: [
      { scope: "filesystem" as const, reason: "watcher unavailable" },
    ],
  };
  expect(compareProcessCaptures(incomplete, incomplete)).toMatchObject({
    filesystem: "unknown",
    status: "unknown",
  });

  const finalFile = {
    path: "root_0:created.txt",
    type: "file" as const,
    mode: 0o644,
    size: 4,
    sha256: "a".repeat(64),
    symlink_target: null,
  };
  expect(
    compareProcessCaptures(capture, {
      ...capture,
      filesystem_checkpoints: [
        { name: "before", at_ms: 0, files: [], effects: [], truncated: false },
        {
          name: "after_settlement",
          at_ms: 10,
          files: [finalFile],
          effects: [
            {
              path: finalFile.path,
              status: "created",
              before: null,
              after: finalFile,
            },
          ],
          truncated: false,
        },
      ],
      files_after: [finalFile],
      filesystem_effects: [
        {
          path: finalFile.path,
          status: "created",
          before: null,
          after: finalFile,
        },
      ],
    }),
  ).toMatchObject({ filesystem: "changed", status: "changed" });
});
