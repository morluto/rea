import { constants as fsConstants } from "node:fs";
import { readlink, realpath, stat } from "node:fs/promises";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  readLinuxProcessStartTime,
  type OwnedInferiorIdentity,
} from "../process/ownedDebuggerSession.js";
import {
  gdbMiConstText,
  gdbMiResultsNamed,
  parseGdbMiDoneRecord,
  parseGdbMiResultRecord,
  type GdbMiValue,
} from "./GdbMiRecord.js";

const containsResultNamed = (value: GdbMiValue, name: string): boolean => {
  switch (value.kind) {
    case "const":
      return false;
    case "list":
      return value.values.some((item) => containsResultNamed(item, name));
    case "tuple":
    case "result-list":
      return value.results.some(
        (result) =>
          result.name === name || containsResultNamed(result.value, name),
      );
  }
};

/**
 * Read the live PIDs of a complete `-list-thread-groups` reply without
 * guessing. The record must hold exactly one top-level `groups` list of
 * tuples, each with one `id` constant, no nested `groups`, and at most one
 * decimal `pid`; a group without `pid` has no live process.
 */
export const gdbThreadGroupPids = (
  mi: string,
): readonly string[] | undefined => {
  const parsed = parseGdbMiResultRecord(mi);
  if (!parsed.ok || parsed.value.resultClass !== "done") return undefined;
  const groupsValues = gdbMiResultsNamed(parsed.value.results, "groups");
  const groups = groupsValues[0];
  if (groupsValues.length !== 1 || groups?.kind !== "list") return undefined;
  const pids: string[] = [];
  for (const group of groups.values) {
    if (group.kind !== "tuple") return undefined;
    const ids = gdbMiResultsNamed(group.results, "id");
    if (ids.length !== 1 || ids[0]?.kind !== "const") return undefined;
    if (containsResultNamed(group, "groups")) return undefined;
    const pidValues = gdbMiResultsNamed(group.results, "pid");
    if (pidValues.length === 0) continue;
    const pid =
      pidValues.length === 1 && pidValues[0] !== undefined
        ? gdbMiConstText(pidValues[0])
        : undefined;
    if (pid === undefined || !/^[1-9]\d*$/u.test(pid)) return undefined;
    pids.push(pid);
  }
  return pids;
};

/** Confirm live inferior stdout/stderr point to the selected TTY on Linux `/proc`. */
export const verifyGdbInferiorOutputSink = async (
  pid: string,
  selectedTty: string,
  rememberIdentity: (identity: OwnedInferiorIdentity) => void,
): Promise<void> => {
  // The descriptors live in this host's /proc, whichever host the manager models.
  if (HOST_PLATFORM.platform !== "linux")
    throw new Error(
      "GDB cannot confirm live inferior output descriptors outside Linux /proc.",
    );
  const before = await readLinuxProcessStartTime(pid);
  if (before === null)
    throw new Error("GDB could not establish the live inferior identity.");
  const ttyPath = await realpath(selectedTty);
  const tty = await stat(ttyPath);
  if ((tty.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR)
    throw new Error("The selected GDB output sink is not a character device.");
  for (const descriptor of ["1", "2"]) {
    const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
    const destination = await readlink(descriptorPath);
    const observed = await stat(descriptorPath);
    if (
      observed.dev !== tty.dev ||
      observed.ino !== tty.ino ||
      (observed.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR ||
      (await realpath(destination)) !== ttyPath
    )
      throw new Error(
        `GDB inferior descriptor ${descriptor} no longer points to the selected TTY.`,
      );
  }
  const after = await readLinuxProcessStartTime(pid);
  if (after !== before)
    throw new Error(
      "The GDB inferior identity changed during descriptor readback.",
    );
  rememberIdentity({ pid, startTime: before });
};

/** Quote a string as a GDB/MI C-string literal. */
export const miQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

/** @internal Decode the only result of a `^done` record, a C-string field. */
export const miStringField = (
  record: string,
  field: string,
): string | undefined => {
  const parsed = parseGdbMiDoneRecord(record);
  if (!parsed.ok) return undefined;
  const [only, ...rest] = parsed.value.results;
  return only?.name === field && rest.length === 0
    ? gdbMiConstText(only.value)
    : undefined;
};
