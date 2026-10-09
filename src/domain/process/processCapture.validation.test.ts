import { expect, it } from "vitest";

import { digestProcessCommitment } from "./processScenario.js";
import { parseProcessCapture } from "./processCaptureParsing.js";
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
