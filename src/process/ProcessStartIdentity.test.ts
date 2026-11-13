import { describe, expect, it, vi } from "vitest";

import type { ProcessOwnershipHost } from "./ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
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
    new Map([
      [
        42,
        identity === undefined
          ? { state: "absent", reason: "not-found-in-caller-pid-namespace" }
          : { state: "readable", identity },
      ],
    ]),
  signalGroup: () => undefined,
});

describe("selected native process identity", () => {
  it.each(["readable", "unavailable"] as const)(
    "does not infer exit from a table omission when native identity is %s",
    async (state) => {
      const omitted: ProcessOwnershipHost = {
        ...host("start-1"),
        listProcesses: async () => [],
        processIdentities: async () =>
          new Map([
            [
              42,
              state === "readable"
                ? { state: "readable", identity: "start-1" }
                : { state: "unavailable", reason: "native inspection denied" },
            ],
          ]),
      };
      await expect(
        observeProcessStartIdentityExit(42, "start-1", omitted),
      ).resolves.toBe(state === "readable" ? "present" : "unverified");
    },
  );

  it.each(["absent", "zombie", "dead"] as const)(
    "uses native %s proof despite a stale live process-table row",
    async (lifecycle) => {
      const exited: ProcessOwnershipHost = {
        ...host("start-1"),
        processIdentities: async () =>
          new Map([
            [
              42,
              lifecycle === "absent"
                ? {
                    state: "absent",
                    reason: "not-found-in-caller-pid-namespace",
                  }
                : {
                    state: "readable",
                    identity: "start-1",
                    lifecycle: { state: "observed", lifecycle },
                  },
            ],
          ]),
      };
      await expect(
        observeProcessStartIdentityExit(42, "start-1", exited),
      ).resolves.toBe("exited");
      const sendSignal = vi.fn();
      await expect(
        signalProcessWithStartIdentity(42, "start-1", "SIGKILL", {
          host: exited,
          sendSignal,
        }),
      ).resolves.toBe("gone");
      expect(sendSignal).not.toHaveBeenCalled();
    },
  );

  it("binds an omitted native PID to its directly observed run token", async () => {
    const omitted: ProcessOwnershipHost = {
      ...host("start-1"),
      listProcesses: async () => [],
      environment: async () => ({ REA_PROCESS_RUN_ID: "captured-run" }),
    };
    await expect(
      observeProcessStartIdentity(42, omitted, "captured-run"),
    ).resolves.toMatchObject({ state: "readable", identity: "start-1" });
  });

  it.each(["unreadable", "foreign", "reused"] as const)(
    "does not bind an omitted PID with a %s token observation",
    async (condition) => {
      let identity = "start-1";
      const omitted: ProcessOwnershipHost = {
        ...host("start-1"),
        listProcesses: async () => [],
        processIdentities: async () =>
          new Map([[42, { state: "readable", identity }]]),
        environment: async () => {
          if (condition === "unreadable") throw new Error("environment denied");
          if (condition === "reused") identity = "replacement-start";
          return {
            REA_PROCESS_RUN_ID:
              condition === "foreign" ? "other-run" : "captured-run",
          };
        },
      };
      await expect(
        observeProcessStartIdentity(42, omitted, "captured-run"),
      ).resolves.toMatchObject({ state: "unavailable" });
    },
  );
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

  it("confirms exit or PID replacement without treating unreadable state as exit", async () => {
    await expect(
      observeProcessStartIdentityExit(42, "start-1", host(undefined)),
    ).resolves.toBe("exited");
    await expect(
      observeProcessStartIdentityExit(42, "start-1", host("replacement-start")),
    ).resolves.toBe("exited");
    await expect(
      observeProcessStartIdentityExit(42, "start-1", host("start-1")),
    ).resolves.toBe("present");
    const unavailable: ProcessOwnershipHost = {
      ...host("start-1"),
      processIdentities: async () =>
        new Map([[42, { state: "unavailable", reason: "reader unavailable" }]]),
    };
    await expect(
      observeProcessStartIdentityExit(42, "start-1", unavailable),
    ).resolves.toBe("unverified");
  });

  it("does not adopt a replacement PID's first identity for an owned launch", async () => {
    const replacement: ProcessOwnershipHost = {
      ...host("replacement-start"),
      environment: async () => ({ REA_PROCESS_RUN_ID: "another-run" }),
    };
    await expect(
      observeProcessStartIdentity(42, replacement, "captured-run"),
    ).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("ownership"),
    });
  });

  it("does not establish an owned launch when its token is unreadable", async () => {
    const unreadable: ProcessOwnershipHost = {
      ...host("start-1"),
      runTokens: async () =>
        new Map([
          [42, { state: "unavailable", reason: "environment_errno_EACCES" }],
        ]),
    };
    await expect(
      observeProcessStartIdentity(42, unreadable, "captured-run"),
    ).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("environment_errno_EACCES"),
    });
  });

  it("rejects an identity that changes while the captured run token is read", async () => {
    let identity = "start-1";
    const changing: ProcessOwnershipHost = {
      ...host("start-1"),
      processIdentities: async () =>
        new Map([[42, { state: "readable", identity }]]),
      environment: async () => {
        identity = "replacement-start";
        return { REA_PROCESS_RUN_ID: "captured-run" };
      },
    };
    await expect(
      observeProcessStartIdentity(42, changing, "captured-run"),
    ).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("identity changed"),
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
