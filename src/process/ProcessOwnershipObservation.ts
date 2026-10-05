import { readFile } from "node:fs/promises";

import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";
import { execFileOutput } from "./ExecFileOutput.js";
import type {
  OwnedProcessGroup,
  ProcessGroupObservation,
  ProcessLineageObservation,
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

/** Observe one group without signaling it, failing closed on identity doubt. */
export const observeOwnedProcessGroupWithHost = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost,
): Promise<ProcessGroupObservation> => {
  let members: readonly ProcessTableEntry[];
  try {
    members = (await host.listProcesses()).filter(
      ({ processGroupId }) => processGroupId === ownership.processGroupId,
    );
  } catch (cause: unknown) {
    return {
      state: "unverifiable",
      reason: `process group could not be inspected: ${errorMessage(cause)}`,
    };
  }
  const liveMembers = liveProcesses(members);
  if (liveMembers.length === 0) return { state: "empty" };
  for (const member of liveMembers) {
    try {
      if (
        (await host.environment(member.pid)).REA_PROCESS_RUN_ID !==
        ownership.runId
      )
        return {
          state: "unverifiable",
          reason: "process ownership did not match",
        };
    } catch (cause: unknown) {
      if (!(await processIsGone(host, member.pid))) {
        return {
          state: "unverifiable",
          reason: `process ownership could not be revalidated for PID ${member.pid}: ${errorMessage(cause)}`,
        };
      }
    }
  }
  return { state: "alive" };
};

/** Record the live launcher and descendant lineage after run-token validation. */
export const observeOwnedProcessLineageWithHost = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost,
): Promise<ProcessLineageObservation> => {
  let processes: readonly ProcessTableEntry[];
  try {
    processes = liveProcesses(await host.listProcesses());
  } catch (cause: unknown) {
    return unavailableLineage(
      ownership,
      `process table could not be inspected: ${errorMessage(cause)}`,
    );
  }
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  if (launcher === undefined)
    return unavailableLineage(ownership, "owned launcher is not live");
  const identityFailure = launcherIdentityFailure(launcher, ownership);
  if (identityFailure !== null)
    return unavailableLineage(ownership, identityFailure);
  const descendants = descendantsOf(launcher.pid, processes);
  const verifiedDescendants: ProcessTableEntry[] = [];
  for (const member of [launcher, ...descendants]) {
    try {
      if (
        (await host.environment(member.pid)).REA_PROCESS_RUN_ID !==
        ownership.runId
      )
        return unavailableLineage(
          ownership,
          "process lineage contains an unowned or PID-reused process",
        );
      if (member.pid !== launcher.pid) verifiedDescendants.push(member);
    } catch (cause: unknown) {
      if (await processIsGone(host, member.pid)) {
        if (member.pid === launcher.pid)
          return unavailableLineage(
            ownership,
            "owned launcher exited during lineage validation",
          );
        continue;
      }
      return unavailableLineage(
        ownership,
        `process ownership could not be revalidated for PID ${member.pid}: ${errorMessage(cause)}`,
      );
    }
  }
  return {
    status: "verified",
    observedAt: new Date().toISOString(),
    lineage: {
      runId: ownership.runId,
      launcherPid: launcher.pid,
      launcherParentPid: launcher.parentPid,
      processGroupId: launcher.processGroupId,
      descendants: verifiedDescendants
        .sort((left, right) => left.pid - right.pid)
        .map(({ pid, parentPid, processGroupId }) => ({
          pid,
          parentPid,
          processGroupId,
        })),
    },
  };
};

const unavailableLineage = (
  ownership: OwnedProcessGroup,
  reason: string,
): Extract<ProcessLineageObservation, { readonly status: "unavailable" }> => ({
  status: "unavailable",
  observedAt: new Date().toISOString(),
  runId: ownership.runId,
  launcherPid: ownership.leaderPid,
  processGroupId: ownership.processGroupId,
  reason,
});

/** Parse the NUL-delimited Linux process environment without nameless keys. */
export const parseProcessEnvironment = (
  value: string,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    value
      .split("\0")
      .filter((entry) => entry.indexOf("=") > 0)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );

/** Create the operating-system process inspector for an explicit host context. */
export const createSystemProcessOwnershipHost = (
  platform: NodeJS.Platform = process.platform,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): ProcessOwnershipHost => ({
  platform,
  async listProcesses() {
    if (platform === "win32") return [];
    const { stdout } = await execFileOutput(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,command="],
      { env: hostEnvironment },
    );
    return stdout
      .split("\n")
      .map((line) => /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        state: match[4] ?? "",
        command: match[5] ?? "",
      }));
  },
  async environment(pid) {
    if (platform === "linux")
      return parseProcessEnvironment(
        await readFile(`/proc/${pid}/environ`, "utf8"),
      );
    const { stdout } = await execFileOutput("ps", ["eww", "-p", String(pid)], {
      env: hostEnvironment,
    });
    const observedEnvironment: Record<string, string> = {};
    for (const match of stdout.matchAll(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/gu,
    )) {
      const name = match[1];
      if (name !== undefined) observedEnvironment[name] = match[2] ?? "";
    }
    return observedEnvironment;
  },
  signalGroup(processGroupId, signal) {
    process.kill(-processGroupId, signal);
  },
});

const systemHost = createSystemProcessOwnershipHost();

/** Observe one group without signaling it, failing closed on identity doubt. */
export const observeOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessGroupObservation> =>
  observeOwnedProcessGroupWithHost(ownership, host);

/**
 * Record the live launcher and descendant lineage after run-token validation.
 *
 * The observation is intentionally point-in-time. A verified empty descendant
 * list means no descendants were live during this observation, not that the
 * run never created a short-lived child.
 */
export const observeOwnedProcessLineage = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessLineageObservation> =>
  observeOwnedProcessLineageWithHost(ownership, host);

const processIsGone = async (
  host: ProcessOwnershipHost,
  pid: number,
): Promise<boolean> => {
  try {
    return !liveProcesses(await host.listProcesses()).some(
      (process) => process.pid === pid,
    );
  } catch (cause: unknown) {
    // best-effort cleanup: optional liveness probing; failure means not gone.
    void cause;
    return false;
  }
};

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
