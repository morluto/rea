import { expect, it } from "vitest";

import {
  assertVerifierCleanupComplete,
  createVerifierPhaseTimings,
} from "../../../scripts/lib/verifier-run.mjs";

it("requires verified empty lineage before claiming verifier cleanup", () => {
  expect(() =>
    assertVerifierCleanupComplete({
      status: "unavailable",
      observed_at: "2026-10-14T00:00:00.000Z",
      launcher_pid: 100,
      launcher_parent_pid: 1,
      process_group_id: null,
      reason: "snapshot unavailable",
    }),
  ).toThrow("Verifier cleanup could not be verified: snapshot unavailable");

  expect(() =>
    assertVerifierCleanupComplete({
      status: "verified",
      observed_at: "2026-10-14T00:00:00.000Z",
      launcher_pid: 100,
      launcher_parent_pid: 1,
      process_group_id: 100,
      descendants: [{ pid: 101, parent_pid: 100, process_group_id: 100 }],
    }),
  ).toThrow("Owned descendants survived verifier cleanup");

  expect(() =>
    assertVerifierCleanupComplete({
      status: "verified",
      observed_at: "2026-10-14T00:00:00.000Z",
      launcher_pid: 100,
      launcher_parent_pid: 1,
      process_group_id: 100,
      descendants: [],
    }),
  ).not.toThrow();
});

it("retains elapsed phase timings when a failed phase is followed by cleanup", () => {
  let now = 100;
  const timings = createVerifierPhaseTimings(() => now);

  timings.begin("pack");
  now += 1200.2;
  timings.begin("install");
  now += 327.8;
  timings.finish("failed");
  now += 10;
  timings.begin("cleanup");
  now += 15;
  timings.finish();

  expect(timings.snapshot()).toEqual([
    { phase: "pack", duration_ms: 1200, status: "completed" },
    { phase: "install", duration_ms: 328, status: "failed" },
    { phase: "cleanup", duration_ms: 15, status: "completed" },
  ]);
});
