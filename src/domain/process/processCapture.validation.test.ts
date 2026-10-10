import { expect, it } from "vitest";

import { digestProcessCommitment } from "./processScenario.js";
import { parseProcessCapture } from "./processCaptureParsing.js";
import { partialProcessCaptureObservationSchema } from "./processCapture.js";
import { FINALIZED_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";
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
    signals: [
      {
        signal: "SIGTERM" as const,
        sent_at_ms: 0,
        delivery: "signaled" as const,
      },
    ],
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
    signals: [
      {
        signal: "SIGTERM" as const,
        sent_at_ms: 0,
        delivery: "signaled" as const,
      },
    ],
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
  expect(
    () =>
      parseProcessCapture(
        withCommittedFinalization(500, {
          ...exit,
          finalization: { ...finalization, elapsed_ms: null },
        }),
      ),
    "a complete capture requires an observed finalization exit time",
  ).toThrow("finalization");
});

it("validates finalization signal observations", () => {
  const finalization = {
    requested_ms: 500,
    signals: [
      {
        signal: "SIGTERM" as const,
        sent_at_ms: 0,
        delivery: "signaled" as const,
      },
    ],
    elapsed_ms: 10,
  };
  expect(
    finalizationConsistencyIssue({
      reason: "exited",
      finalization,
    }),
    "an exited reason cannot carry finalization",
  ).toContain("finalization");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: {
        ...finalization,
        signals: [{ signal: "SIGKILL", sent_at_ms: 500 }],
      },
    }),
    "the first attempt is SIGTERM",
  ).toContain("SIGTERM");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: {
        ...finalization,
        signals: [
          { signal: "SIGTERM", sent_at_ms: 0 },
          { signal: "SIGKILL", sent_at_ms: 500 },
          { signal: "SIGKILL", sent_at_ms: 600 },
        ],
      },
    }),
    "only one SIGKILL is allowed",
  ).toContain("one final SIGKILL");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: {
        ...finalization,
        signals: [
          { signal: "SIGTERM", sent_at_ms: 10 },
          { signal: "SIGKILL", sent_at_ms: 5 },
        ],
      },
    }),
    "attempt times stay ordered",
  ).toContain("must not decrease");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: {
        ...finalization,
        signals: [
          { signal: "SIGTERM", sent_at_ms: 0 },
          { signal: "SIGKILL", sent_at_ms: 499 },
        ],
      },
    }),
    "a non-cancelled early SIGKILL is rejected",
  ).toContain("requested interval");
  expect(
    finalizationConsistencyIssue({
      reason: "cancelled",
      finalization: {
        ...finalization,
        signals: [
          { signal: "SIGTERM", sent_at_ms: 0 },
          { signal: "SIGKILL", sent_at_ms: 1 },
        ],
      },
    }),
    "a cancelled early SIGKILL is accepted",
  ).toBeUndefined();
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: {
        ...finalization,
        signals: [{ signal: "SIGTERM", sent_at_ms: 1 }],
        elapsed_ms: 0,
      },
    }),
    "the observed exit cannot precede the first attempt",
  ).toContain("elapsed_ms");
  expect(
    finalizationConsistencyIssue({
      reason: "timeout",
      finalization: { ...finalization, elapsed_ms: null },
    }),
    "an observed exit requires elapsed time",
  ).toContain("elapsed_ms");
  expect(
    finalizationConsistencyIssue(
      { reason: "timeout" },
      { finalization_ms: 500 },
    ),
    "a deadline exit with a committed interval must carry the record",
  ).toContain("finalization evidence");
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
    signals: [
      {
        signal: "SIGTERM" as const,
        sent_at_ms: 0,
        delivery: "signaled" as const,
      },
    ],
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
    partial({
      code: null,
      signal: null,
      reason: "timeout",
      finalization: { ...finalization, elapsed_ms: null },
    }).success,
    "a capture variant requires an observed finalization exit time",
  ).toBe(false);
  expect(
    () =>
      parseProcessCapture(
        withCommittedFinalization(500, {
          code: null,
          signal: null,
          reason: "timeout",
          finalization: {
            ...finalization,
            signals: [
              { signal: "SIGINT", sent_at_ms: 0, delivery: "signaled" },
            ],
          },
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
    signals: [
      {
        signal: "SIGTERM" as const,
        sent_at_ms: 0,
        delivery: "signaled" as const,
      },
    ],
    elapsed_ms: 10,
  };
  const unavailable = { state: "unavailable", reason: "not observed" };
  const incomplete = (
    exit: Record<string, unknown> | undefined,
    manifest: ReturnType<typeof withCommittedFinalization>["manifest"],
    incompleteFinalization: Record<string, unknown> | undefined = undefined,
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
        finalization:
          incompleteFinalization === undefined
            ? unavailable
            : { state: "available", value: incompleteFinalization },
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
    incomplete(undefined, committed, { ...finalization, elapsed_ms: null })
      .success,
    "a finalization observed without an exit permits null elapsed time",
  ).toBe(true);
  expect(
    incomplete(undefined, committed, {
      ...finalization,
      signals: [{ signal: "SIGKILL", sent_at_ms: 0, delivery: "signaled" }],
    }).success,
    "an incomplete finalization still starts with SIGTERM",
  ).toBe(false);
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
  const earlyKill = {
    requested_ms: 500,
    elapsed_ms: null,
    signals: [
      { signal: "SIGTERM", sent_at_ms: 0, delivery: "signaled" },
      { signal: "SIGKILL", sent_at_ms: 40, delivery: "unverified" },
    ],
  };
  expect(
    incomplete(undefined, committed, earlyKill).success,
    "an unobserved exit may still keep a cancellation's early SIGKILL attempt",
  ).toBe(true);
  expect(
    incomplete({ ...timeout }, committed, earlyKill).success,
    "a deadline exit cannot carry a SIGKILL before the requested interval",
  ).toBe(false);
  expect(
    incomplete(undefined, differing).success,
    "an unavailable exit still cannot hide a contradictory manifest",
  ).toBe(false);
});

it("accepts the canonical finalized capture example", () => {
  expect(
    parseProcessCapture(FINALIZED_PROCESS_CAPTURE_EXAMPLE).exit,
    "the advertised finalized example is a valid capture",
  ).toMatchObject({
    reason: "timeout",
    finalization: { requested_ms: 1_500, signals: [{ signal: "SIGTERM" }] },
  });
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
