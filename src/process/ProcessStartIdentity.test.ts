import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";

import type {
  ProcessIdentityObservation,
  ProcessOwnershipHost,
} from "./ProcessOwnership.js";
import {
  PROCESS_CLEANUP_VERIFICATION_GRACE_MS,
  PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS,
  type ProcessLifecycle,
} from "./ProcessLifecycle.js";
import {
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
  signalProcessWithStartIdentity,
} from "./ProcessOwnershipObservation.js";

const pid = 42;
const start = "start-1";
const replacement = "replacement-start";
const runId = "captured-run";
const row = {
  pid,
  parentPid: 1,
  processGroupId: 42,
  uid: 1000,
  state: "S",
  command: "/bin/fixture",
};
const readable = (
  identity = start,
  lifecycle?: ProcessLifecycle,
): ProcessIdentityObservation => ({
  state: "readable",
  identity,
  ...(lifecycle === undefined
    ? {}
    : { lifecycle: { state: "observed", lifecycle } }),
});
const absent = {
  state: "absent",
  reason: "not-found-in-caller-pid-namespace",
} as const satisfies ProcessIdentityObservation;
const unavailable = {
  state: "unavailable",
  reason: "native inspection denied",
} as const satisfies ProcessIdentityObservation;

const host = (
  observe: () => ProcessIdentityObservation,
  listed = true,
): ProcessOwnershipHost => ({
  platform: "linux",
  listProcesses: async () => (listed ? [row] : []),
  environment: async () => ({}),
  processIdentities: async (selected) =>
    new Map(
      selected.filter((item) => item.pid === pid).map(() => [pid, observe()]),
    ),
  signalGroup: () => undefined,
});

it("returns the live process start identity by PID", async () => {
  await expect(
    observeProcessStartIdentity(pid, host(readable)),
  ).resolves.toEqual({
    state: "readable",
    identity: start,
  });
});

it.each([
  {
    native: "absence",
    observation: absent,
    listed: true,
    exit: "exited",
    signal: "gone",
  },
  {
    native: "zombie",
    observation: readable(start, "zombie"),
    listed: true,
    exit: "exited",
    signal: "gone",
  },
  {
    native: "dead",
    observation: readable(start, "dead"),
    listed: true,
    exit: "exited",
    signal: "gone",
  },
  {
    native: "replacement",
    observation: readable(replacement),
    listed: true,
    exit: "exited",
    signal: "identity-changed",
  },
  {
    native: "unavailable",
    observation: unavailable,
    listed: false,
    exit: "unverified",
    signal: "unverified",
  },
  {
    native: "live",
    observation: readable(),
    listed: false,
    exit: "present",
    signal: "signaled",
  },
] as const)(
  "uses native $native to decide exit and signal authority",
  async ({ observation, listed, exit, signal }) => {
    const source = host(() => observation, listed);
    await expect(
      observeProcessStartIdentityExit(pid, start, source),
    ).resolves.toBe(exit);
    const sendSignal = vi.fn();
    await expect(
      signalProcessWithStartIdentity(pid, start, "SIGKILL", {
        host: source,
        sendSignal,
      }),
    ).resolves.toBe(signal);
    if (signal === "signaled")
      expect(sendSignal).toHaveBeenCalledExactlyOnceWith(pid, "SIGKILL");
    else expect(sendSignal).not.toHaveBeenCalled();
  },
);

it.each([
  { listed: false, token: "matches" },
  { listed: false, token: "denied" },
  { listed: true, token: "denied" },
  { listed: false, token: "foreign" },
  { listed: true, token: "foreign" },
  { listed: false, token: "reused" },
  { listed: true, token: "reused" },
] as const)(
  "binds a PID to its native generation and captured token ($token, listed $listed)",
  async ({ listed, token }) => {
    let identity = token === "foreign" ? replacement : start;
    const source = host(() => readable(identity), listed);
    const adapter: ProcessOwnershipHost = {
      ...source,
      ...(listed && token === "denied"
        ? {
            runTokens: async () =>
              new Map([
                [pid, { state: "unavailable", reason: "environment denied" }],
              ]),
          }
        : {}),
      environment: async () => {
        if (token === "denied") throw new Error("environment denied");
        if (token === "reused") identity = replacement;
        return {
          REA_PROCESS_RUN_ID: token === "foreign" ? "another-run" : runId,
        };
      },
    };
    const result = await observeProcessStartIdentity(pid, adapter, runId);
    if (token === "matches")
      expect(result).toEqual({ state: "readable", identity: start });
    else
      expect(result).toMatchObject({
        state: "unavailable",
        reason: expect.stringContaining(
          {
            denied: "environment denied",
            foreign: "token did not match",
            reused: "identity changed",
          }[token],
        ),
      });
  },
);

const exiting = readable(start, "exiting");

it.each([
  ["zombie", readable(start, "zombie"), "exited"],
  ["absent", absent, "exited"],
  ["replaced", readable(replacement), "exited"],
  ["unavailable", unavailable, "unverified"],
] as const)(
  "settles an observed exit in progress that becomes %s",
  async (_mode, final, expected) => {
    let reads = 0;
    const source = host(() => (++reads < 3 ? exiting : final));
    const observing = observeProcessStartIdentityExit(pid, start, source);
    await expect(observing).resolves.toBe(expected);
    expect(reads).toBe(3);
  },
);

it("reports exiting only after the cleanup grace expires and skips the wait for a live process", async () => {
  vi.useFakeTimers();
  const clock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => Date.now());
  try {
    const exitingOutcome = vi.fn();
    const observing = observeProcessStartIdentityExit(
      pid,
      start,
      host(() => exiting),
    ).then(exitingOutcome);
    let liveReads = 0;
    const liveOutcome = vi.fn();
    const observingLive = observeProcessStartIdentityExit(
      pid,
      start,
      host(() => {
        liveReads += 1;
        return readable(start, "non-zombie");
      }),
    ).then(liveOutcome);
    await vi.advanceTimersByTimeAsync(
      PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS - 1,
    );
    expect(liveOutcome).toHaveBeenCalledExactlyOnceWith("present");
    expect(liveReads).toBe(1);
    await vi.advanceTimersByTimeAsync(
      PROCESS_CLEANUP_VERIFICATION_GRACE_MS -
        PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS,
    );
    expect(exitingOutcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exitingOutcome).toHaveBeenCalledExactlyOnceWith("exiting");
    await Promise.all([observing, observingLive]);
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
});
