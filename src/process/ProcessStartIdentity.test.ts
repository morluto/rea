import { describe, expect, it, vi } from "vitest";

import type { ProcessOwnershipHost } from "./ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  signalProcessWithStartIdentity,
} from "./ProcessOwnershipObservation.js";

const host = (identity: string | undefined): ProcessOwnershipHost => ({
  platform: "linux",
  listProcesses: async () =>
    identity === undefined
      ? []
      : [
          {
            pid: 42,
            parentPid: 1,
            processGroupId: 42,
            uid: 1000,
            state: "S",
            command: "/bin/fixture",
          },
        ],
  environment: async () => ({}),
  processIdentities: async () =>
    new Map([[42, { state: "readable", identity: identity ?? "" }]]),
  signalGroup: () => undefined,
});

describe("process start identity lease", () => {
  it("captures a readable identity for a live PID", async () => {
    await expect(
      observeProcessStartIdentity(42, host("start-1")),
    ).resolves.toEqual({
      state: "readable",
      identity: "start-1",
    });
  });

  it("signals the PID when its launch identity still matches", async () => {
    const sendSignal = vi.fn();
    await expect(
      signalProcessWithStartIdentity(42, "start-1", "SIGKILL", {
        host: host("start-1"),
        sendSignal,
      }),
    ).resolves.toBe("signaled");
    expect(sendSignal).toHaveBeenCalledWith(42, "SIGKILL");
  });

  it("does not signal a reused PID even when its command is unchanged", async () => {
    const sendSignal = vi.fn();
    await expect(
      signalProcessWithStartIdentity(42, "start-1", "SIGKILL", {
        host: host("start-2"),
        sendSignal,
      }),
    ).resolves.toBe("identity-changed");
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("does not signal when the PID identity is unavailable", async () => {
    const unavailable: ProcessOwnershipHost = {
      ...host("start-1"),
      processIdentities: async () =>
        new Map([[42, { state: "unavailable", reason: "reader unavailable" }]]),
    };
    const sendSignal = vi.fn();
    await expect(
      signalProcessWithStartIdentity(42, "start-1", "SIGKILL", {
        host: unavailable,
        sendSignal,
      }),
    ).resolves.toBe("unverified");
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("reports an already-gone PID without signaling", async () => {
    const sendSignal = vi.fn();
    await expect(
      signalProcessWithStartIdentity(42, "start-1", "SIGKILL", {
        host: host(undefined),
        sendSignal,
      }),
    ).resolves.toBe("gone");
    expect(sendSignal).not.toHaveBeenCalled();
  });
});
