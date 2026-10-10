import { expect, it } from "vitest";

import { digestProcessCommitment } from "./processScenario.js";
import { parseProcessCapture } from "./processCaptureParsing.js";
import { partialProcessCaptureObservationSchema } from "./processCapture.js";
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
  comparisonCommitted: number | "same" | "absent" = "same",
) => {
  const capture = emptyCapture();
  const scenario = {
    ...capture.manifest.scenario,
    ...(committed === undefined ? {} : { finalization_ms: committed }),
  };
  const comparisonContract = {
    ...capture.manifest.comparison_contract,
    ...(comparisonCommitted === "absent"
      ? {}
      : comparisonCommitted === "same"
        ? committed === undefined
          ? {}
          : { finalization_ms: committed }
        : { finalization_ms: comparisonCommitted }),
  };
  return {
    ...capture,
    manifest: {
      ...capture.manifest,
      scenario,
      comparison_contract: comparisonContract,
      full_scenario_sha256: digestProcessCommitment(scenario),
      comparison_contract_sha256: digestProcessCommitment(comparisonContract),
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
    finalizationConsistencyIssue({
      reason: "cancelled",
      signal: 9,
      finalization: forced,
    }),
    "cancellation ends the interval early",
  ).toBeUndefined();
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      signal: 9,
      finalization: forced,
    }),
    "a deadline escalation waits for the whole interval",
  ).toContain("requested interval");
  expect(
    finalizationConsistencyIssue({
      reason: "exited",
      signal: 9,
      finalization: forced,
    }),
    "partial exits need a deadline reason too",
  ).toContain("deadline exit reason");
  expect(
    finalizationConsistencyIssue(
      { reason: "cancelled", signal: 9, finalization: forced },
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

it("validates finalization evidence in partial captures and rejects malformed records", () => {
  const { cleanup: _cleanup, ...completed } = emptyCapture();
  const partial = (exit: Record<string, unknown>) =>
    partialProcessCaptureObservationSchema.safeParse({
      capture: { ...completed, exit },
      cleanup: {
        owned_process_group: { state: "cleaned", reason: null },
        terminal_renderer: { state: "cleaned", reason: null },
        temporary_root: { state: "cleaned", reason: null },
      },
      execution_failure: "capture ended after a fixture error",
    });
  const finalization = {
    requested_ms: 500,
    signal: "SIGTERM",
    outcome: "target_exited",
    elapsed_ms: 10,
  };

  expect(
    partial({ code: null, signal: null, reason: "timeout" }).success,
    "a partial exit without finalization stays valid",
  ).toBe(true);
  expect(
    partial({ code: 0, signal: null, reason: "exited", finalization }).success,
    "a partial exit cannot finalize without a deadline",
  ).toBe(false);
  expect(
    partial({
      code: null,
      signal: null,
      reason: "timeout",
      finalization: { ...finalization, requested_ms: 700 },
    }).success,
    "a partial record must match the committed interval",
  ).toBe(false);
  expect(
    () =>
      parseProcessCapture(
        withCommittedFinalization(500, {
          code: null,
          signal: null,
          reason: "timeout",
          finalization: { ...finalization, signal: "SIGINT" },
        }),
      ),
    "only SIGTERM can start finalization",
  ).toThrow();
  expect(
    () =>
      parseProcessCapture(
        withCommittedFinalization(500, {
          code: null,
          signal: null,
          reason: "timeout",
          finalization: { ...finalization, elapsed_ms: -1 },
        }),
      ),
    "elapsed time cannot be negative",
  ).toThrow();
});

it("binds the comparison contract to the committed finalization interval", () => {
  const exit = { code: 0, signal: null, reason: "exited" };

  expect(
    () => parseProcessCapture(withCommittedFinalization(500, exit, "absent")),
    "a scenario interval missing from the comparison contract is contradictory",
  ).toThrow("comparison_contract");
  expect(
    () => parseProcessCapture(withCommittedFinalization(500, exit, 900)),
    "a different comparison interval is contradictory",
  ).toThrow("comparison_contract");
  expect(
    () => parseProcessCapture(withCommittedFinalization(undefined, exit, 500)),
    "a comparison interval the scenario never committed is contradictory",
  ).toThrow("comparison_contract");
});

it("validates finalization evidence in incomplete observations", () => {
  const finalization = {
    requested_ms: 500,
    signal: "SIGTERM",
    outcome: "target_exited",
    elapsed_ms: 10,
  };
  const unavailable = { state: "unavailable", reason: "not observed" };
  const incomplete = (
    exit: Record<string, unknown> | undefined,
    manifest: ReturnType<typeof withCommittedFinalization>["manifest"],
  ) => {
    const result = partialProcessCaptureObservationSchema.safeParse({
      observations: {
        target_pid: unavailable,
        frames: { state: "available", value: [] },
        rendered_frames: unavailable,
        interaction_events: unavailable,
        exit:
          exit === undefined
            ? unavailable
            : { state: "available", value: exit },
        settlement: unavailable,
        process_samples: unavailable,
        filesystem_snapshots: { before: unavailable, after: unavailable },
        event_journal: unavailable,
        manifest: { state: "available", value: manifest },
      },
      cleanup: {
        owned_process_group: { state: "cleaned", reason: null },
        terminal_renderer: { state: "cleaned", reason: null },
        temporary_root: { state: "cleaned", reason: null },
      },
      execution_failure: "capture ended after a fixture error",
    });
    return {
      success: result.success,
      messages: result.success
        ? ""
        : result.error.issues.map(({ message }) => message).join("; "),
    };
  };
  const timeout = { code: null, signal: null, reason: "timeout" };
  const normal = { code: 0, signal: null, reason: "exited" };
  const committed = withCommittedFinalization(500, timeout).manifest;

  expect(
    incomplete({ ...timeout, finalization }, committed).success,
    "a consistent incomplete record is accepted",
  ).toBe(true);
  expect(
    incomplete(normal, withCommittedFinalization(undefined, normal).manifest)
      .success,
    "an incomplete capture that never committed an interval is accepted",
  ).toBe(true);
  expect(
    incomplete(
      { code: 0, signal: null, reason: "exited", finalization },
      committed,
    ).success,
    "an incomplete exit cannot finalize without a deadline",
  ).toBe(false);
  expect(
    incomplete(
      { ...timeout, finalization: { ...finalization, requested_ms: 700 } },
      committed,
    ).success,
    "an incomplete record must match the committed interval",
  ).toBe(false);
  expect(
    incomplete(
      {
        ...timeout,
        signal: 15,
        finalization: {
          ...finalization,
          outcome: "forced_kill",
          elapsed_ms: 500,
        },
      },
      committed,
    ).success,
    "an incomplete forced kill needs an observed SIGKILL",
  ).toBe(false);

  const scenarioOnly = withCommittedFinalization(
    500,
    normal,
    "absent",
  ).manifest;
  const comparisonOnly = withCommittedFinalization(
    undefined,
    normal,
    500,
  ).manifest;
  const differing = withCommittedFinalization(500, normal, 900).manifest;
  for (const [label, manifest] of [
    ["a scenario interval missing from the comparison contract", scenarioOnly],
    ["a comparison interval the scenario never committed", comparisonOnly],
    ["differing intervals", differing],
  ] as const) {
    const verdict = incomplete(normal, manifest);
    expect(verdict.success, `${label} is rejected`).toBe(false);
    expect(
      verdict.messages,
      `${label} is rejected for the comparison contract`,
    ).toContain("comparison_contract");
  }
  expect(
    incomplete(undefined, differing).success,
    "an unavailable exit still cannot hide a contradictory manifest",
  ).toBe(false);
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
