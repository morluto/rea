import { beforeEach, expect, it, vi } from "vitest";

const execFileOutput = vi.hoisted(() => vi.fn());
vi.mock("./ExecFileOutput.js", async (original) => ({
  ...(await original<typeof import("./ExecFileOutput.js")>()),
  execFileOutput,
}));

import { ExecFileOutputCancelledError } from "./ExecFileOutput.js";
import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";

const host = createSystemProcessOwnershipHost("freebsd", {});
const start = "Sun Oct 25 21:04:30 2026";
const pids = [100, 101, 102, 103, 104, 105].map((pid) => ({ pid }));

beforeEach(() => {
  execFileOutput.mockReset();
});

it("keeps incomplete and omitted identities unresolved alongside usable rows", async () => {
  execFileOutput.mockResolvedValue({
    stdout: [
      "  100 1 100 1001 S",
      `  101 1 100 1001 Ss ${start}`,
      `  102 1 100 1001 Z ${start}`,
      `  103 1 100 1001 RE ${start}`,
      "  104 1 100 1001 S Sun Oct 25 21:04",
    ].join("\n"),
  });

  const observed = await host.processIdentities!(pids);
  expect(observed.get(101)).toEqual({
    state: "readable",
    identity: `freebsd-lstart:${start}`,
    effectiveUid: 1001,
    lifecycle: { state: "observed", lifecycle: "non-zombie" },
    relation: { state: "observed", parentPid: 1, processGroupId: 100 },
  });
  expect(observed.get(102)).toMatchObject({
    lifecycle: { state: "observed", lifecycle: "zombie" },
  });
  expect(observed.get(103)).toMatchObject({
    lifecycle: { state: "observed", lifecycle: "exiting" },
  });
  for (const pid of [100, 104, 105])
    expect(observed.get(pid)).toMatchObject({ state: "unavailable" });
});

it("keeps a requested identity unresolved when ps finds no visible rows", async () => {
  execFileOutput.mockRejectedValue(
    Object.assign(new Error("ps exited with status 1"), {
      code: 1,
      stdout: "",
      stderr: "",
    }),
  );
  await expect(host.processIdentities!([{ pid: 100 }])).resolves.toEqual(
    new Map([
      [
        100,
        {
          state: "unavailable",
          reason: "process not visible in FreeBSD ps snapshot",
        },
      ],
    ]),
  );
});

it("propagates typed inspection cancellation", async () => {
  const controller = new AbortController();
  const reason = { phase: "owned cleanup" };
  execFileOutput.mockImplementation(async () => {
    controller.abort(reason);
    throw new ExecFileOutputCancelledError(reason);
  });
  await expect(
    host.processIdentities!([{ pid: 100 }], controller.signal),
  ).rejects.toMatchObject({
    _tag: "ProcessOwnershipInspectionCancelled",
    reason,
  });
});

it("refuses owned launch admission and environment authority on the exploratory host", async () => {
  await expect(host.prepare!()).rejects.toMatchObject({
    code: "baseline_unavailable",
  });
  await expect(host.environment(100)).rejects.toMatchObject({
    availability: "unavailable",
  });
});
