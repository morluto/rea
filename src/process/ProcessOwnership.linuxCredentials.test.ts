import { expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: filesystem.readFile,
}));

import {
  createSystemProcessOwnershipHost,
  readProcessOwnershipFacts,
} from "./ProcessOwnershipObservation.js";
import { verifyNoTokenOwnedProcesses } from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";

const denied = (code: string) =>
  Object.assign(new Error(`${code}: fixture access failure`), { code });

it
  .skipIf(typeof process.getuid !== "function")
  .each([
    "foreign-account",
    "foreign-account-eperm",
    "same-account-stale-ps",
    "related-foreign-account",
    "unknown-identity",
    "replaced-identity",
    "denied-status",
    "malformed-status",
    "missing-uid",
    "duplicate-uid",
    "non-access-failure",
    "readable-token",
  ])("binds Linux ownership credentials to native facts: %s", async (mode) => {
  const callerUid = process.getuid!();
  const foreignUid = callerUid === 0 ? 1 : 0;
  const related = mode === "related-foreign-account";
  const permission = mode === "foreign-account-eperm" ? "EPERM" : "EACCES";
  const row = {
    pid: 900,
    parentPid: related ? 100 : 1,
    processGroupId: related ? 100 : 900,
    uid: mode === "same-account-stale-ps" ? foreignUid : callerUid,
    state: "S",
    command: "native-credential-fixture",
  };
  let statReads = 0;
  const uid = mode === "same-account-stale-ps" ? callerUid : foreignUid;
  const uidLine = `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  filesystem.readFile.mockReset();
  filesystem.readFile.mockImplementation(async (path: string) => {
    if (path === "/proc/900/stat") {
      if (mode === "unknown-identity") throw denied("EACCES");
      statReads += 1;
      const fields = Array<string>(20).fill("0");
      fields[0] = "S";
      fields[1] = String(row.parentPid);
      fields[2] = String(row.processGroupId);
      fields[3] = "900";
      fields[19] = mode === "replaced-identity" ? String(statReads) : "100";
      return `900 (fixture) ${fields.join(" ")}`;
    }
    if (path === "/proc/900/environ") {
      if (mode === "readable-token") return "PUBLIC=fixture\0";
      throw denied(mode === "non-access-failure" ? "EIO" : permission);
    }
    if (path === "/proc/900/status") {
      if (mode === "denied-status") throw denied("EACCES");
      if (mode === "malformed-status") return "Uid:\t0\tbad\t0\t0\n";
      if (mode === "missing-uid") return "Name:\tfixture\n";
      return mode === "duplicate-uid" ? uidLine + uidLine : uidLine;
    }
    throw new Error(`unexpected proc read: ${path}`);
  });
  const signalGroup = vi.fn();
  const host = {
    ...createSystemProcessOwnershipHost("linux", {}),
    listProcesses: async () => [row],
    signalGroup,
  };
  const result = await verifyNoTokenOwnedProcesses("run-token", host, [], {
    leaderPid: 100,
    processGroupId: 100,
    evidenceOwner: new ProcessOwnershipEvidenceOwner(),
  });
  if (mode.startsWith("foreign-account")) {
    expect(result).toEqual({
      cleaned: true,
      signaled: false,
      unverified: [
        { pid: row.pid, diagnostic: `${permission}: fixture access failure` },
      ],
    });
  } else if (mode === "readable-token") {
    expect(result).toEqual({ cleaned: true, signaled: false });
  } else {
    expect(result).toMatchObject({
      cleaned: false,
      failures: [
        {
          pid: row.pid,
          reason:
            mode === "unknown-identity" || mode === "replaced-identity"
              ? "process-identity-unavailable"
              : "environment-unreadable",
        },
      ],
    });
  }
  const statusReads = filesystem.readFile.mock.calls.filter(
    ([path]) => path === "/proc/900/status",
  );
  if (mode === "readable-token") expect(statusReads).toHaveLength(0);
  else if (mode.startsWith("foreign-account"))
    expect(statusReads.length).toBeGreaterThan(0);
  expect(signalGroup).not.toHaveBeenCalled();
});

it.each(["environ", "status"])(
  "preserves cancellation during the Linux %s read",
  async (stage) => {
    const controller = new AbortController();
    const reason = new Error("cancel native credential inspection");
    filesystem.readFile.mockReset();
    filesystem.readFile.mockImplementation(
      async (path: string, options: { signal?: AbortSignal }) => {
        expect(options.signal).toBe(controller.signal);
        if (path.endsWith("/stat")) {
          const fields = Array<string>(20).fill("0");
          fields[0] = "S";
          fields[1] = "1";
          fields[2] = "900";
          fields[19] = "100";
          return `900 (fixture) ${fields.join(" ")}`;
        }
        if (!path.endsWith(`/${stage}`)) throw denied("EACCES");
        controller.abort(reason);
        throw reason;
      },
    );
    const host = createSystemProcessOwnershipHost("linux", {});
    await expect(
      readProcessOwnershipFacts(
        [
          {
            pid: 900,
            parentPid: 1,
            processGroupId: 900,
            state: "S",
            command: "fixture",
          },
        ],
        host,
        controller.signal,
      ),
    ).rejects.toBe(reason);
  },
);
