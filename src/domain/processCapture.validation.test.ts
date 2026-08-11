import { expect, it } from "vitest";

import {
  digestProcessCommitment,
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  parseProcessCapture,
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";
import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyUnverifiedProcessCapture as emptyCapture,
  processCaptureIssues,
} from "./processCapture.fixture.js";

it("never considers truncated captures equivalent", () => {
  const capture = {
    schema_version: 4 as const,
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
    process_samples: [],
    filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
    shim_events: [],
    protocol_events: [],
    replay_transitions: [],
    reactive_run: null,
    files_before: [],
    files_after: [],
    filesystem_effects: [],
    truncated: true,
    limitations: [],
    residual_unknowns: [],
    cleanup: {
      owned_process_group: "verified" as const,
      temporary_root: "removed" as const,
    },
  };
  expect(compareProcessCaptures(capture, capture).status).toBe("truncated");
});

it("rejects altered v4 commitments and accepts canonical key reordering", () => {
  const capture = emptyCapture();
  expect(parseProcessCapture(capture)).toEqual(capture);
  expect(digestProcessCommitment({ second: 2, first: 1 })).toBe(
    digestProcessCommitment({ first: 1, second: 2 }),
  );
  expect(() =>
    parseProcessCapture({
      ...capture,
      manifest: {
        ...capture.manifest,
        normalization_sha256: "f".repeat(64),
      },
    }),
  ).toThrow("normalization_sha256");
  expect(() =>
    parseProcessCapture({
      ...capture,
      manifest: {
        ...capture.manifest,
        executable_sha256: "f".repeat(64),
      },
    }),
  ).toThrow("executable_sha256");
});

it("rejects settlement and cleanup combinations that cannot occur", () => {
  const capture = emptyCapture();
  expect(() =>
    parseProcessCapture({
      ...capture,
      settlement: {
        state: "quiesced",
        elapsed_ms: 0,
        cleanup_outcome: "cleaned",
      },
    }),
  ).toThrow("cleanup_outcome");
  expect(() =>
    parseProcessCapture({
      ...capture,
      settlement: {
        state: "alive_at_deadline",
        elapsed_ms: 1,
        cleanup_outcome: "not_required",
      },
    }),
  ).toThrow("cleanup_outcome");
});

it("accepts old captures without a journal and validates complete journals", () => {
  const capture = emptyCapture();
  const { event_journal: _eventJournal, ...oldCapture } = capture;
  expect(parseProcessCapture(oldCapture).event_journal).toEqual([]);

  const eventJournal = [
    { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 0 },
    { capture_order: 2, collection: "lifecycle", index: 1 },
    { capture_order: 3, collection: "filesystem_checkpoints", index: 1 },
  ] as const;
  expect(
    processCaptureIssues({ ...capture, event_journal: eventJournal }),
  ).toEqual([]);

  for (const [candidate, message] of [
    [
      eventJournal.map((entry, index) =>
        index === 1 ? { ...entry, capture_order: 2 } : entry,
      ),
      "contiguous",
    ],
    [
      eventJournal.map((entry, index) =>
        index === 3
          ? { ...entry, collection: "lifecycle" as const, index: 1 }
          : entry,
      ),
      "unique",
    ],
    [eventJournal.slice(0, 3), "every captured observation"],
    [
      eventJournal.map((entry, index) =>
        index === 3 ? { ...entry, index: 2 } : entry,
      ),
      "outside",
    ],
  ] as const) {
    expect(
      processCaptureIssues({ ...capture, event_journal: candidate }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(message),
        }),
      ]),
    );
  }
});

it.each([
  ["machine limit", 1, 5, 10],
  ["transition use limit", 5, 1, 10],
  ["state visit limit", 5, 5, 1],
])(
  "rejects replay journals that exceed the declared %s",
  (_name, maxTransitions, maxUses, maxVisits) => {
    const replayPlan = {
      machine: {
        initial_state: "active",
        states: [
          { name: "active", max_visits: maxVisits },
          { name: "complete", terminal: true },
        ],
        transitions: [
          {
            id: "again",
            from: "active",
            to: "active",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "again",
            },
            actions: [{ type: "websocket_send", data: "again" }],
            max_uses: maxUses,
          },
          {
            id: "finish",
            from: "active",
            to: "complete",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "finish",
            },
            actions: [{ type: "websocket_send", data: "done" }],
            max_uses: 1,
          },
        ],
        max_transitions: maxTransitions,
      },
    };
    const capture = emptyCapture();
    const candidate: UnverifiedProcessCapture = {
      ...capture,
      manifest: {
        ...capture.manifest,
        replay_plan: replayPlan,
        replay_plan_sha256: digestProcessCommitment(replayPlan),
      },
      replay_transitions: [0, 1].map((sequence) => ({
        sequence,
        at_ms: sequence,
        transition_id: "again",
        state_before: "active",
        state_after: "active",
        sensitive_aliases: [],
      })),
    };

    expect(processCaptureIssues(candidate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("limit"),
        }),
      ]),
    );
  },
);

it("tells agents and users to recapture unsupported v3 evidence", () => {
  const legacy = { ...emptyCapture(), schema_version: 3 };
  expect(() => parseProcessCapture(legacy)).toThrow(
    LEGACY_PROCESS_CAPTURE_MESSAGE,
  );
  const parsed = processCaptureSchema.safeParse(legacy);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("expected legacy capture rejection");
  expect(parsed.error.issues[0]?.message).toBe(LEGACY_PROCESS_CAPTURE_MESSAGE);
});

it("requires compatible contracts and enforces capture age through a clock seam", () => {
  const capture = emptyCapture();
  expect(() =>
    compareProcessCaptures(capture, {
      ...capture,
      manifest: {
        ...capture.manifest,
        comparison_contract: { changed: true },
        comparison_contract_sha256: digestProcessCommitment({
          changed: true,
        }),
      },
    }),
  ).toThrow("incompatible comparison contracts");
  expect(() =>
    compareProcessCaptures(capture, capture, {
      maxCaptureAgeMs: 1,
      now: () => Date.parse("2026-01-01T00:00:01.000Z"),
    }),
  ).toThrow("max_capture_age_ms");
});
