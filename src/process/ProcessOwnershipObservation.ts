import { readFile } from "node:fs/promises";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";

import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";
import { execFileOutput } from "./ExecFileOutput.js";
import {
  createDarwinProcessRunTokenReader,
  type DarwinProcessReaderCompiler,
} from "./DarwinProcessRunTokenReader.js";
import { readProcessRunTokens } from "./ProcessRunTokenObservations.js";
import type {
  OwnedProcessGroup,
  ProcessGroupObservation,
  ProcessLineageObservation,
  ProcessOwnershipHost,
  ProcessIdentityObservation,
  ProcessOwnershipBaseline,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

/** Observe multiple groups from one process snapshot and one token batch. */
export const observeOwnedProcessGroups = async (
  runId: string,
  processGroupIds: readonly number[],
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, ProcessGroupObservation>> => {
  signal?.throwIfAborted();
  const groupIds = [...new Set(processGroupIds)];
  if (groupIds.length === 0) return new Map();
  let processes: readonly ProcessTableEntry[];
  try {
    processes = liveProcesses(await host.listProcesses(signal));
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    const failure = {
      state: "unverifiable" as const,
      reason: `process group could not be inspected: ${errorMessage(cause)}`,
    };
    return new Map(groupIds.map((groupId) => [groupId, failure]));
  }
  signal?.throwIfAborted();
  const membersByGroup = new Map(
    groupIds.map((groupId) => [groupId, [] as ProcessTableEntry[]]),
  );
  for (const process of processes)
    membersByGroup.get(process.processGroupId)?.push(process);
  const observations = new Map<number, ProcessGroupObservation>(
    groupIds.map((groupId) => [
      groupId,
      (membersByGroup.get(groupId)?.length ?? 0) > 0
        ? { state: "alive" }
        : { state: "empty" },
    ]),
  );
  const liveMembers = groupIds.flatMap(
    (groupId) => membersByGroup.get(groupId) ?? [],
  );
  const pendingGroups = new Set(
    groupIds.filter(
      (groupId) => (membersByGroup.get(groupId)?.length ?? 0) > 0,
    ),
  );
  for await (const { process: member, observation } of readProcessRunTokens(
    host,
    liveMembers,
    signal,
  )) {
    if (!pendingGroups.has(member.processGroupId)) continue;
    if (observation.state === "readable") {
      if (observation.runId !== runId) {
        observations.set(member.processGroupId, {
          state: "unverifiable",
          reason: "process ownership did not match",
        });
        pendingGroups.delete(member.processGroupId);
      }
    } else {
      const gone = await processIsGone(host, member.pid);
      signal?.throwIfAborted();
      if (!gone) {
        observations.set(member.processGroupId, {
          state: "unverifiable",
          reason: `process ownership could not be revalidated for PID ${member.pid}: ${observation.reason}`,
        });
        pendingGroups.delete(member.processGroupId);
      }
    }
    if (pendingGroups.size === 0) break;
  }
  signal?.throwIfAborted();
  return observations;
};

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
  const descendants = descendantsOf([launcher.pid], processes);
  const verifiedDescendants: ProcessTableEntry[] = [];
  for await (const { process: member, observation } of readProcessRunTokens(
    host,
    [launcher, ...descendants],
  )) {
    if (observation.state === "readable") {
      if (observation.runId !== ownership.runId)
        return unavailableLineage(
          ownership,
          "process lineage contains an unowned or PID-reused process",
        );
      if (member.pid !== launcher.pid) verifiedDescendants.push(member);
    } else {
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
        `process ownership could not be revalidated for PID ${member.pid}: ${observation.reason}`,
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
    readonly darwinCompiler?: DarwinProcessReaderCompiler;
    /** Override the caller-owned module cache used compiling that helper. */
    readonly darwinModuleCachePath?: string;
  } = {},
): ProcessOwnershipHost => {
  const darwinModuleCachePath =
    options.darwinModuleCachePath ??
    hostEnvironment.REA_DARWIN_MODULE_CACHE_PATH;
  const swiftcPath = hostEnvironment.REA_DARWIN_SWIFTC_PATH;
  const darwinCompiler =
    options.darwinCompiler ??
    (swiftcPath === undefined || swiftcPath === ""
      ? undefined
      : {
          kind: "swiftc" as const,
          executable: swiftcPath,
          sdkRoot: hostEnvironment.SDKROOT ?? "",
        });
  const darwinTokens =
    platform === "darwin"
      ? createDarwinProcessRunTokenReader({
          ...(darwinCompiler === undefined ? {} : { compiler: darwinCompiler }),
          ...(darwinModuleCachePath === undefined
            ? {}
            : { moduleCachePath: darwinModuleCachePath }),
        })
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
      if (platform === "linux") {
        try {
          const processes = await listProcesses(signal);
          if (!processes.some(({ pid }) => pid === process.pid))
            throw new Error("ps did not report REA's current process");
        } catch (cause: unknown) {
          if (isExpectedAbort(cause, signal)) throw cause;
          const reason = `Linux process ownership inspection requires a procps-compatible ps on REA's PATH before launching a child: ${errorMessage(cause)}`;
          throw new AnalysisCapabilityUnavailableError(
            "process-ownership",
            "prepare_owned_process",
            reason,
            { cause, userMessage: reason },
          );
        }
      }
    },
    listProcesses,
    async environment(pid, signal) {
      signal?.throwIfAborted();
      if (platform === "linux")
        return parseProcessEnvironment(
          await readFile(`/proc/${pid}/environ`, { encoding: "utf8", signal }),
        );
      if (platform === "darwin") {
        const process = (await listProcesses(signal)).find(
          (entry) => entry.pid === pid,
        );
        if (process === undefined)
          throw new Error(`process ${String(pid)} is not live`);
        const observation = (await darwinTokens?.read([process], signal))?.get(
          pid,
        );
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
          ...(signal === undefined ? {} : { signal }),
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
    async runTokens(processes, signal) {
      signal?.throwIfAborted();
      if (platform !== "darwin" || processes.length === 0) return new Map();
      try {
        return (await darwinTokens?.read(processes, signal)) ?? new Map();
      } catch (cause: unknown) {
        if (isExpectedAbort(cause, signal)) throw cause;
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

/**
 * Observe a live PID's start identity, optionally binding it to an owned run.
 * Token validation is bracketed by identity reads so PID reuse cannot supply
 * the first identity of a different process for an owned launch.
 */
export const observeProcessStartIdentity = async (
  pid: number,
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
  expectedRunId?: string,
): Promise<ProcessIdentityObservation | undefined> => {
  const process = (await host.listProcesses()).find(
    (entry) => entry.pid === pid,
  );
  if (process === undefined || liveProcesses([process]).length === 0)
    return undefined;
  if (host.processIdentities === undefined)
    return { state: "unavailable", reason: "process identity is unsupported" };
  const identity: ProcessIdentityObservation = (
    await host.processIdentities([process])
  ).get(pid) ?? {
    state: "unavailable",
    reason: "process identity was not returned",
  };
  if (expectedRunId === undefined || identity.state !== "readable")
    return identity;
  let owned = false;
  for await (const { observation } of readProcessRunTokens(host, [process])) {
    if (observation.state === "unavailable")
      return {
        state: "unavailable",
        reason: `process ownership token could not be read for PID ${String(pid)}: ${observation.reason}`,
      };
    if (observation.runId !== expectedRunId)
      return {
        state: "unavailable",
        reason: `process ownership token did not match the captured run for PID ${String(pid)}`,
      };
    owned = true;
  }
  if (!owned)
    return {
      state: "unavailable",
      reason: `process ownership token was not returned for PID ${String(pid)}`,
    };
  const confirmed = await observeProcessStartIdentity(pid, host);
  if (confirmed === undefined || confirmed.state !== "readable")
    return confirmed;
  return confirmed.identity === identity.identity
    ? identity
    : {
        state: "unavailable",
        reason: `process identity changed while validating the captured run token for PID ${String(pid)}`,
      };
};

/** Revalidate a launch-time start identity immediately before signaling a PID. */
export const signalProcessWithStartIdentity = async (
  pid: number,
  expectedIdentity: string,
  signal: NodeJS.Signals,
  options: {
    readonly host?: ProcessOwnershipHost;
    readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<"signaled" | "gone" | "identity-changed" | "unverified"> => {
  const host = options.host ?? systemProcessOwnershipHost;
  try {
    const observed = await observeProcessStartIdentity(pid, host);
    if (observed === undefined) return "gone";
    if (observed.state !== "readable") return "unverified";
    if (observed.identity !== expectedIdentity) return "identity-changed";
    (options.sendSignal ?? process.kill)(pid, signal);
    return "signaled";
  } catch {
    return "unverified";
  }
};

/** Prepare native token inspection before REA launches a captured child. */
export const prepareProcessOwnershipInspection = async (
  signal?: AbortSignal,
): Promise<void> => {
  await systemProcessOwnershipHost.prepare?.(signal);
};

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
