import { expect, it } from "vitest";

import { digestProcessCommitment } from "./processScenario.js";
import { parseProcessCapture } from "./processCaptureParsing.js";
import { finalizationConsistencyIssue } from "./processCaptureValidation.js";
import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyUnverifiedProcessCapture as emptyCapture,
  processCaptureIssues,
} from "./processCapture.fixture.js";

it("never considers truncated captures equivalent", () => {
  const complete = emptyCapture();
  const capture = {
    ...complete,
    truncated: true,
    truncation_details: {
      ...complete.truncation_details,
      raw_terminal: {
        ...complete.truncation_details.raw_terminal,
        observed_bytes: 1,
        observed_frames: 1,
      },
    },
  };
  expect(compareProcessCaptures(capture, capture).status).toBe("unknown");
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
  ).toThrow("executable_identity");
});

it("requires producer coverage accounting in every parsed capture", () => {
  const capture = emptyCapture();
  const { truncation_details: _details, ...missingCoverage } = capture;
  expect(() => parseProcessCapture(missingCoverage)).toThrow(
    "truncation_details",
  );
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

it("rejects finalization evidence that no deadline could have produced", () => {
  const capture = emptyCapture();
  const finalization = {
    requested_ms: 500,
    signal: "SIGTERM" as const,
    outcome: "target_exited" as const,
    elapsed_ms: 10,
  };
  expect(
    () =>
      parseProcessCapture({
        ...capture,
        exit: { code: 0, signal: null, reason: "exited", finalization },
      }),
    "an exit without a deadline cannot carry a finalization record",
  ).toThrow("finalization");
  expect(
    () =>
      parseProcessCapture({
        ...capture,
        exit: {
          code: null,
          signal: null,
          reason: "timeout",
          finalization: {
            ...finalization,
            outcome: "forced_kill",
            elapsed_ms: 499,
          },
        },
      }),
    "a forced kill cannot precede the requested interval",
  ).toThrow("finalization");
});

const withCommittedFinalization = (
  committed: number | undefined,
  exit: Record<string, unknown>,
) => {
  const capture = emptyCapture();
  const scenario = {
    ...capture.manifest.scenario,
    ...(committed === undefined ? {} : { finalization_ms: committed }),
  };
  return {
    ...capture,
    manifest: {
      ...capture.manifest,
      scenario,
      full_scenario_sha256: digestProcessCommitment(scenario),
    },
    exit,
  };
};

it("binds finalization evidence to the committed finalization interval", () => {
  const finalization = {
    requested_ms: 500,
    signal: "SIGTERM",
    outcome: "target_exited",
    elapsed_ms: 10,
  };
  const exit = { code: null, signal: null, reason: "timeout", finalization };

  expect(
    parseProcessCapture(withCommittedFinalization(500, exit)).exit,
    "a record matching the committed interval is accepted",
  ).toMatchObject({ finalization });
  expect(
    () => parseProcessCapture(withCommittedFinalization(700, exit)),
    "a different committed interval contradicts the record",
  ).toThrow("finalization");
  expect(
    () => parseProcessCapture(withCommittedFinalization(undefined, exit)),
    "a scenario that committed no interval cannot have finalized",
  ).toThrow("finalization");
});

it("allows an early forced kill only for a cancelled exit", () => {
  const forced = {
    requested_ms: 500,
    signal: "SIGTERM" as const,
    outcome: "forced_kill" as const,
    elapsed_ms: 1,
  };

  expect(
    finalizationConsistencyIssue({ reason: "cancelled", finalization: forced }),
    "cancellation ends the interval early",
  ).toBeUndefined();
  expect(
    finalizationConsistencyIssue({ reason: "timeout", finalization: forced }),
    "a deadline escalation waits for the whole interval",
  ).toContain("requested interval");
  expect(
    finalizationConsistencyIssue({ reason: "exited", finalization: forced }),
    "partial exits need a deadline reason too",
  ).toContain("deadline exit reason");
  expect(
    finalizationConsistencyIssue(
      { reason: "cancelled", finalization: forced },
      { finalization_ms: 900 },
    ),
    "the committed interval must match when the manifest is known",
  ).toContain("committed");
});

it("ties finalization evidence to the observed exit and to a committed interval", () => {
  const finalization = {
    requested_ms: 500,
    signal: "SIGTERM" as const,
    outcome: "forced_kill" as const,
    elapsed_ms: 500,
  };

  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      signal: 15,
      finalization,
    }),
    "a forced kill must show SIGKILL in the observed exit",
  ).toContain("SIGKILL");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      signal: 9,
      finalization,
    }),
    "a forced kill that ended on SIGKILL is consistent",
  ).toBeUndefined();
  expect(
    finalizationConsistencyIssue(
      { reason: "timeout", signal: 9 },
      { finalization_ms: 500 },
    ),
    "a deadline exit with a committed interval must carry the record",
  ).toContain("finalization evidence");
  expect(
    finalizationConsistencyIssue(
      { reason: "cancelled", signal: 9 },
      {
        finalization_ms: 500,
      },
    ),
    "cancellation before the deadline has no finalization record",
  ).toBeUndefined();
  expect(
    finalizationConsistencyIssue({ reason: "timeout", signal: 9 }, {}),
    "a scenario without an interval needs no record",
  ).toBeUndefined();
});

it("requires an explicit journal and validates complete journals", () => {
  const capture = emptyCapture();
  const { event_journal: _eventJournal, ...oldCapture } = capture;
  expect(() => parseProcessCapture(oldCapture)).toThrow("event_journal");

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

it("rejects old executable identity representations without migration", () => {
  const capture = emptyCapture();
  const {
    selected_executable_sha256: _selected,
    executable_identity: _identity,
    ...oldManifest
  } = capture.manifest;
  expect(() =>
    parseProcessCapture({ ...capture, manifest: oldManifest }),
  ).toThrow();
  expect(() =>
    parseProcessCapture({
      ...capture,
      manifest: {
        ...capture.manifest,
        legacy_executable_sha256: capture.manifest.executable_sha256,
      },
    }),
  ).toThrow("legacy_executable_sha256");
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
  ).toThrow(
    expect.objectContaining({
      issues: [
        expect.objectContaining({
          path: ["right"],
          message: expect.stringContaining(
            "incompatible comparison contracts; these scenario fields differ: changed",
          ),
          expected: ["changed"],
        }),
      ],
    }),
  );
  expect(() =>
    compareProcessCaptures(capture, capture, {
      maxCaptureAgeMs: 1,
      now: () => Date.parse("2026-01-01T00:00:01.000Z"),
    }),
  ).toThrow(
    expect.objectContaining({
      issues: [
        expect.objectContaining({
          path: ["max_capture_age_ms"],
          reason: "out_of_range",
          message: expect.stringContaining("left completed at"),
        }),
      ],
    }),
  );
});
