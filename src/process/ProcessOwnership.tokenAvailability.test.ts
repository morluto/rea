import { expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  present: true,
  reason: "process_not_in_snapshot",
  identity: undefined as string | undefined,
  runId: undefined as string | undefined,
  reads: [] as number[][],
}));
vi.mock("./ExecFileOutput.js", async (original) => ({
  ...(await original<typeof import("./ExecFileOutput.js")>()),
  execFileOutput: async () => ({
    stdout: source.present ? "100 1 100 501 S fixture" : "",
  }),
}));
vi.mock("./DarwinProcessRunTokenReader.js", () => ({
  createDarwinProcessRunTokenReader: () => ({
    read: async (processes: readonly { readonly pid: number }[]) => {
      source.reads.push(processes.map(({ pid }) => pid));
      return new Map(
        processes.map(({ pid }) => [
          pid,
          source.runId === undefined
            ? { state: "unavailable" as const, reason: source.reason }
            : { state: "readable" as const, runId: source.runId },
        ]),
      );
    },
    identities: async (processes: readonly { readonly pid: number }[]) =>
      new Map(
        processes.map(({ pid }) => [
          pid,
          source.identity === undefined
            ? { state: "absent" as const, reason: "not-in-snapshot" as const }
            : { state: "readable" as const, identity: source.identity },
        ]),
      ),
  }),
}));

import {
  createSystemProcessOwnershipHost,
  observeProcessStartIdentity,
} from "./ProcessOwnershipObservation.js";
import { ProcessRunTokenReadError } from "./ProcessRunTokenObservations.js";

it.each([
  { present: false, reason: "unused", availability: "absent" },
  { present: true, reason: "process_not_in_snapshot", availability: "absent" },
  { present: true, reason: "sysctl_failed_13", availability: "unavailable" },
])(
  "retains native run-token availability at the host adapter: %j",
  async (state) => {
    Object.assign(source, state, {
      identity: undefined,
      runId: undefined,
      reads: [],
    });
    const host = createSystemProcessOwnershipHost("darwin", {});
    const failure = await host
      .environment(100)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessRunTokenReadError);
    expect(failure).toMatchObject({
      pid: 100,
      availability: state.availability,
      reason: state.present ? state.reason : "process_not_in_snapshot",
    });
  },
);

it("binds an omitted Darwin PID through the native token reader", async () => {
  Object.assign(source, {
    present: false,
    reason: "process_not_in_snapshot",
    identity: "start-1",
    runId: "captured-run",
    reads: [],
  });
  const host = createSystemProcessOwnershipHost("darwin", {});
  await expect(
    observeProcessStartIdentity(100, host, "captured-run"),
  ).resolves.toEqual({ state: "readable", identity: "start-1" });
  expect(source.reads).toEqual([[100]]);
});
