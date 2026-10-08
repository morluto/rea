import { expect, it } from "vitest";

import {
  digestProcessCommitment,
  parseProcessCapture,
  type UnverifiedProcessCapture,
} from "./processCapture.js";
import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyUnverifiedProcessCapture as emptyCapture,
  processCaptureIssues,
} from "./processCapture.fixture.js";

it("never considers truncated captures equivalent", () => {
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
    process_samples: [],
    filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
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
  ).toThrow("executable_identity");
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

it("migrates persisted v3 executable digests without claiming a selected digest", () => {
  const capture = emptyCapture();
  const {
    selected_executable_sha256: _selectedExecutableSha256,
    executable_identity: _executableIdentity,
    executable_sha256,
    ...legacyManifest
  } = capture.manifest;
  const legacyCapture = {
    ...capture,
    manifest: { ...legacyManifest, executable_sha256 },
  };

  const migrated = parseProcessCapture(legacyCapture);

  expect(migrated.manifest).toMatchObject({
    selected_executable_sha256: null,
    executable_sha256: null,
    executable_identity: {
      state: "unknown",
      reason: expect.stringContaining("did not distinguish"),
    },
    legacy_executable_sha256: executable_sha256,
    scenario: capture.manifest.scenario,
    full_scenario_sha256: capture.manifest.full_scenario_sha256,
  });
  expect(compareProcessCaptures(migrated, migrated)).toMatchObject({
    status: "unchanged",
  });
  const exported = JSON.stringify(migrated);
  expect(parseProcessCapture(JSON.parse(exported))).toEqual(migrated);

  expect(() =>
    parseProcessCapture({
      ...legacyCapture,
      manifest: {
        ...legacyCapture.manifest,
        executable_sha256: "f".repeat(64),
      },
    }),
  ).toThrow("legacy_executable_sha256");

  const nullDigestScenario = {
    ...legacyCapture.manifest.scenario,
    executable_sha256: null,
  };
  const malformedLegacyBase = {
    ...legacyCapture,
    manifest: {
      ...legacyCapture.manifest,
      executable_sha256: null,
      scenario: nullDigestScenario,
      full_scenario_sha256: digestProcessCommitment(nullDigestScenario),
    },
  };
  expect(() => parseProcessCapture(malformedLegacyBase)).toThrow();
  expect(() =>
    parseProcessCapture({
      ...malformedLegacyBase,
      manifest: {
        ...malformedLegacyBase.manifest,
        executable_sha256: "not-a-digest",
      },
    }),
  ).toThrow();
  const {
    executable_sha256: _missingLegacyDigest,
    ...manifestWithoutLegacyDigest
  } = malformedLegacyBase.manifest;
  expect(() =>
    parseProcessCapture({
      ...malformedLegacyBase,
      manifest: manifestWithoutLegacyDigest,
    }),
  ).toThrow();

  const { executable_identity: _missingIdentity, ...incompleteModernManifest } =
    capture.manifest;
  expect(() =>
    parseProcessCapture({
      ...capture,
      manifest: incompleteModernManifest,
    }),
  ).toThrow();
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
