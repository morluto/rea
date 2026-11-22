import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

/**
 * @typedef {{
 *   readonly run_id: string;
 *   readonly verifier_pid: number;
 *   readonly parent_pid: number;
 * }} VerifierRunStart
 */
/**
 * @typedef {{
 *   readonly pid: number;
 *   readonly parent_pid: number;
 *   readonly process_group_id: number;
 * }} VerifierRunDescendant
 */
/**
 * @typedef {(
 *   | {
 *       readonly status: "verified";
 *       readonly observed_at: string;
 *       readonly launcher_pid: number;
 *       readonly launcher_parent_pid: number;
 *       readonly process_group_id: number;
 *       readonly descendants: readonly VerifierRunDescendant[];
 *     }
 *   | {
 *       readonly status: "unavailable";
 *       readonly observed_at: string;
 *       readonly launcher_pid: number;
 *       readonly launcher_parent_pid: number;
 *       readonly process_group_id: number | null;
 *       readonly reason: string;
 *     }
 * )} VerifierProcessLineage
 */
/**
 * @typedef {VerifierRunStart & {
 *   readonly process_lineage: VerifierProcessLineage;
 * }} VerifierRun
 */
/** @typedef {{ readonly pid: number; readonly parentPid: number; readonly processGroupId: number }} ProcessMember */

/** @type {{ readonly report: VerifierRunStart, readonly processRunId: string } | undefined} */
let activeVerifierRun;

/**
 * Allocate one verifier report identity before work and propagate a process token.
 * A verifier launched as an owned command can retain its caller's process token
 * so its descendants remain attributable during interruption and cleanup.
 * @param {{ readonly inheritProcessRunId?: boolean }} [options]
 * @returns {VerifierRunStart}
 */
export const createVerifierRun = (options = {}) => {
  if (activeVerifierRun === undefined) {
    const report = Object.freeze({
      run_id: randomUUID(),
      verifier_pid: process.pid,
      parent_pid: process.ppid,
    });
    const inherited = options.inheritProcessRunId
      ? process.env.REA_PROCESS_RUN_ID
      : undefined;
    activeVerifierRun = { report, processRunId: inherited || report.run_id };
  }
  process.env.REA_PROCESS_RUN_ID = activeVerifierRun.processRunId;
  return activeVerifierRun.report;
};

/**
 * Time sequential verifier phases with a monotonic clock.
 * @param {() => number} [now]
 */
export const createVerifierPhaseTimings = (now = () => performance.now()) => {
  /** @type {{ phase: string, duration_ms: number, status: "completed" | "failed" }[]} */
  const timings = [];
  /** @type {{ phase: string, started: number } | undefined} */
  let active;

  /** @param {"completed" | "failed"} [status] */
  const finish = (status = "completed", ended = now()) => {
    if (active === undefined) return;
    timings.push({
      phase: active.phase,
      duration_ms: Math.round(ended - active.started),
      status,
    });
    active = undefined;
  };

  return {
    /** @param {string} phase */
    begin(phase) {
      const started = now();
      finish("completed", started);
      active = { phase, started };
    },
    finish,
    snapshot: () => [...timings],
  };
};

/**
 * Complete a verifier report with a token-verified point-in-time lineage.
 *
 * An empty descendant list means none were live during this observation. It
 * does not prove that the verifier never launched children earlier in the run.
 * @param {VerifierRunStart} run
 * @returns {Promise<VerifierRun>}
 */
export const completeVerifierRun = async (run) => {
  const observedAt = new Date().toISOString();
  return {
    ...run,
    process_lineage: await observeVerifierLineage(run, observedAt),
  };
};

/**
 * Require positive process-lineage evidence before claiming cleanup complete.
 * @param {VerifierProcessLineage} processLineage
 */
export const assertVerifierCleanupComplete = (processLineage) => {
  if (processLineage.status !== "verified")
    throw new Error(
      `Verifier cleanup could not be verified: ${processLineage.reason}`,
    );
  if (processLineage.descendants.length !== 0)
    throw new Error("Owned descendants survived verifier cleanup");
};

/**
 * @param {VerifierRunStart} run
 * @param {string} observedAt
 * @returns {Promise<VerifierProcessLineage>}
 */
const observeVerifierLineage = async (run, observedAt) => {
  if (process.platform === "win32")
    return unavailableLineage(
      run,
      observedAt,
      null,
      "The verifier has no retained native Job Object lease for lineage observation; provider jobs are verified by their native owners",
    );
  try {
    const { members, observerPid } = await processSnapshot();
    const launcher = members.find(({ pid }) => pid === run.verifier_pid);
    if (launcher === undefined)
      return unavailableLineage(
        run,
        observedAt,
        null,
        "verifier launcher was absent from the process snapshot",
      );
    if (launcher.parentPid !== run.parent_pid)
      return unavailableLineage(
        run,
        observedAt,
        launcher.processGroupId,
        "verifier launcher parent changed before lineage observation",
      );
    const descendants = descendantMembers(
      members.filter(({ pid }) => pid !== observerPid),
      run.verifier_pid,
    );
    const expectedProcessRunId =
      activeVerifierRun?.report === run
        ? activeVerifierRun.processRunId
        : run.run_id;
    for (const member of descendants) {
      let memberRunId;
      try {
        memberRunId = await processRunId(member.pid);
      } catch {
        return unavailableLineage(
          run,
          observedAt,
          launcher.processGroupId,
          `descendant ${String(member.pid)} environment was unreadable`,
        );
      }
      if (memberRunId !== expectedProcessRunId)
        return unavailableLineage(
          run,
          observedAt,
          launcher.processGroupId,
          `descendant ${String(member.pid)} run token did not match`,
        );
    }
    return {
      status: "verified",
      observed_at: observedAt,
      launcher_pid: run.verifier_pid,
      launcher_parent_pid: run.parent_pid,
      process_group_id: launcher.processGroupId,
      descendants: descendants
        .map(({ pid, parentPid, processGroupId }) => ({
          pid,
          parent_pid: parentPid,
          process_group_id: processGroupId,
        }))
        .sort((left, right) => left.pid - right.pid),
    };
  } catch {
    return unavailableLineage(
      run,
      observedAt,
      null,
      "operating-system process lineage could not be inspected",
    );
  }
};

/**
 * @param {VerifierRunStart} run
 * @param {string} observedAt
 * @param {number | null} processGroupId
 * @param {string} reason
 * @returns {VerifierProcessLineage}
 */
const unavailableLineage = (run, observedAt, processGroupId, reason) => ({
  status: "unavailable",
  observed_at: observedAt,
  launcher_pid: run.verifier_pid,
  launcher_parent_pid: run.parent_pid,
  process_group_id: processGroupId,
  reason,
});

/** @returns {Promise<{ members: ProcessMember[]; observerPid: number | null }>} */
const processSnapshot = async () => {
  if (process.platform === "linux") return linuxProcessSnapshot();
  return posixProcessSnapshot();
};

/** @type {Promise<typeof import("../../src/process/LinuxProcessStat.js")> | undefined} */
let linuxStatParser;

const linuxProcessSnapshot = async () => {
  // The pinned Node can strip this leaf module without a transform or loader.
  linuxStatParser ??= import(
    new URL("../../src/process/LinuxProcessStat.ts", import.meta.url).href
  );
  const { parseLinuxProcessStat } = await linuxStatParser;
  const entries = await readdir("/proc", { withFileTypes: true });
  /** @type {ProcessMember[]} */
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
      const parsed = parseLinuxProcessStat(stat);
      if (
        parsed === undefined ||
        parsed.pid !== Number(entry.name) ||
        parsed.lifecycle === "zombie" ||
        parsed.lifecycle === "dead"
      )
        continue;
      const { pid, parentPid, processGroupId } = parsed;
      members.push({ pid, parentPid, processGroupId });
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }
  return { members, observerPid: null };
};

const posixProcessSnapshot = async () => {
  const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {Buffer[]} */
  const stdout = [];
  /** @type {Buffer[]} */
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw new Error(`ps failed: ${Buffer.concat(stderr).toString("utf8")}`);
  const members = Buffer.concat(stdout)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const match = /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
      return match === null || match[4]?.startsWith("Z")
        ? []
        : [
            {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              processGroupId: Number(match[3]),
            },
          ];
    });
  return { members, observerPid: child.pid ?? null };
};

/**
 * @param {readonly ProcessMember[]} members
 * @param {number} launcherPid
 */
const descendantMembers = (members, launcherPid) => {
  const descendantPids = new Set([launcherPid]);
  let previousSize = -1;
  while (previousSize !== descendantPids.size) {
    previousSize = descendantPids.size;
    for (const member of members)
      if (descendantPids.has(member.parentPid)) descendantPids.add(member.pid);
  }
  descendantPids.delete(launcherPid);
  return members.filter(({ pid }) => descendantPids.has(pid));
};

/**
 * @param {number} pid
 * @returns {Promise<string | undefined>}
 */
const processRunId = async (pid) => {
  if (process.platform === "linux") {
    const environment = await readFile(`/proc/${String(pid)}/environ`, "utf8");
    return environment
      .split("\0")
      .find((entry) => entry.startsWith("REA_PROCESS_RUN_ID="))
      ?.slice("REA_PROCESS_RUN_ID=".length);
  }
  const child = spawn("ps", ["eww", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  /** @type {Buffer[]} */
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error("process environment unavailable");
  return /(?:^|\s)REA_PROCESS_RUN_ID=([^\s]*)/u.exec(
    Buffer.concat(stdout).toString("utf8"),
  )?.[1];
};
