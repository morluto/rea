import { readFile } from "node:fs/promises";

import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";
import { execFileOutput } from "./ExecFileOutput.js";
import { createDarwinProcessRunTokenReader } from "./DarwinProcessRunTokenReader.js";
import type {
  OwnedProcessGroup,
  ProcessGroupObservation,
  ProcessLineageObservation,
  ProcessOwnershipHost,
  ProcessIdentityObservation,
  ProcessOwnershipBaseline,
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

/** Read Linux stat field 22, tolerating spaces and closing parentheses in comm. */
export const parseLinuxProcessStartTime = (
  value: string,
): string | undefined => {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = value
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  return startTime !== undefined && /^\d+$/u.test(startTime)
    ? startTime
    : undefined;
};

const isExpectedAbort = (
  cause: unknown,
  signal: AbortSignal | undefined,
): boolean =>
  signal?.aborted === true &&
  (cause === signal.reason ||
    (cause instanceof Error && cause.name === "AbortError"));

/** Create the operating-system process inspector for an explicit host context. */
export const createSystemProcessOwnershipHost = (
  platform: NodeJS.Platform = process.platform,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  options: {
    /** Override the compiler executable used by the Darwin native reader. */
    readonly darwinXcrun?: string;
  } = {},
): ProcessOwnershipHost => {
  const darwinTokens =
    platform === "darwin"
      ? createDarwinProcessRunTokenReader(
          options.darwinXcrun === undefined
            ? {}
            : { xcrun: options.darwinXcrun },
        )
      : undefined;
  const listProcesses = async (signal?: AbortSignal) => {
    if (platform === "win32") return [];
    const { stdout } = await execFileOutput(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
      { env: hostEnvironment, ...(signal === undefined ? {} : { signal }) },
    );
    return stdout
      .split("\n")
      .map((line) =>
        /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)/u.exec(line),
      )
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        uid: Number(match[4]),
        state: match[5] ?? "",
        command: match[6] ?? "",
      }));
  };
  const processIdentities: NonNullable<
    ProcessOwnershipHost["processIdentities"]
  > = async (processes, signal) => {
    if (processes.length === 0) return new Map();
    if (platform === "linux")
      return new Map<number, ProcessIdentityObservation>(
        await Promise.all(
          processes.map(async ({ pid }) => {
            try {
              const stat = await readFile(`/proc/${String(pid)}/stat`, {
                encoding: "utf8",
                ...(signal === undefined ? {} : { signal }),
              });
              const identity = parseLinuxProcessStartTime(stat);
              return [
                pid,
                identity === undefined
                  ? ({
                      state: "unavailable",
                      reason: "malformed_proc_stat",
                    } as const)
                  : ({
                      state: "readable",
                      identity: `linux-starttime:${identity}`,
                    } as const),
              ] as const;
            } catch (cause: unknown) {
              if (isExpectedAbort(cause, signal)) throw cause;
              return [
                pid,
                { state: "unavailable", reason: errorMessage(cause) } as const,
              ] as const;
            }
          }),
        ),
      );
    if (darwinTokens === undefined) return new Map();
    try {
      return await darwinTokens.identities(processes, signal);
    } catch (cause: unknown) {
      if (isExpectedAbort(cause, signal)) throw cause;
      const reason = errorMessage(cause);
      return new Map(
        processes.map(({ pid }) => [
          pid,
          { state: "unavailable", reason } as const,
        ]),
      );
    }
  };
  const captureBaseline = async (
    signal?: AbortSignal,
  ): Promise<ProcessOwnershipBaseline> => {
    if (platform !== "linux" && darwinTokens === undefined) return [];
    const processes = liveProcesses(await listProcesses(signal));
    let identities = await processIdentities(processes, signal);
    const unreadable = processes.filter(
      ({ pid }) => identities.get(pid)?.state !== "readable",
    );
    if (unreadable.length > 0) {
      const stillLive = liveProcesses(await listProcesses(signal)).filter(
        ({ pid }) => unreadable.some((entry) => entry.pid === pid),
      );
      const retried = await processIdentities(stillLive, signal);
      identities = new Map([...identities, ...retried]);
      const unresolved = stillLive.filter(
        ({ pid }) => identities.get(pid)?.state !== "readable",
      );
      const liveAfterRetry = liveProcesses(await listProcesses(signal));
      const stillUnresolved = unresolved.filter(({ pid }) =>
        liveAfterRetry.some((entry) => entry.pid === pid),
      );
      if (stillUnresolved.length > 0)
        throw new Error(
          `process identity snapshot is unavailable for ${String(stillUnresolved.length)} live processes`,
        );
    }
    return processes.map(({ pid }) => {
      const observation = identities.get(pid);
      return {
        pid,
        identity:
          observation?.state === "readable" ? observation.identity : null,
      };
    });
  };
  return {
    platform,
    prepare: async (signal) => {
      await darwinTokens?.prepare(signal);
    },
    listProcesses,
    async environment(pid) {
      if (platform === "linux")
        return parseProcessEnvironment(
          await readFile(`/proc/${pid}/environ`, "utf8"),
        );
      if (platform === "darwin") {
        const process = (await listProcesses()).find(
          (entry) => entry.pid === pid,
        );
        if (process === undefined)
          throw new Error(`process ${String(pid)} is not live`);
        const observation = (await darwinTokens?.read([process]))?.get(pid);
        if (observation === undefined || observation.state === "unavailable")
          throw new Error(
            observation?.reason ?? "process run token could not be read",
          );
        return observation.runId === undefined
          ? {}
          : { REA_PROCESS_RUN_ID: observation.runId };
      }
      const { stdout } = await execFileOutput(
        "ps",
        ["eww", "-p", String(pid)],
        {
          env: hostEnvironment,
        },
      );
      const observedEnvironment: Record<string, string> = {};
      for (const match of stdout.matchAll(
        /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/gu,
      )) {
        const name = match[1];
        if (name !== undefined) observedEnvironment[name] = match[2] ?? "";
      }
      return observedEnvironment;
    },
    async runTokens(processes) {
      if (platform !== "darwin" || processes.length === 0) return new Map();
      try {
        return (await darwinTokens?.read(processes)) ?? new Map();
      } catch (cause: unknown) {
        void cause;
        return new Map(
          processes.map(({ pid }) => [
            pid,
            { state: "unavailable", reason: "reader_failure" } as const,
          ]),
        );
      }
    },
    ...(platform !== "linux" && darwinTokens === undefined
      ? {}
      : {
          processIdentities,
          captureBaseline,
          ...(darwinTokens === undefined ? {} : { close: darwinTokens.close }),
        }),
    signalGroup(processGroupId, signal) {
      process.kill(-processGroupId, signal);
    },
  };
};

export const systemProcessOwnershipHost = createSystemProcessOwnershipHost();

/** Prepare native token inspection before REA launches a captured child. */
export const prepareProcessOwnershipInspection = async (
  signal?: AbortSignal,
): Promise<void> => {
  await systemProcessOwnershipHost.prepare?.(signal);
};

/** Observe one group without signaling it, failing closed on identity doubt. */
export const observeOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
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
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
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
