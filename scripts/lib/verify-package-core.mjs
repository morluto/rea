import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

/** Promisified child_process execution helper. */
export const exec = promisify(execFile);

/** Run a command and return its stdout. */
export const run = async (command, args, env) =>
  (await exec(command, args, { env })).stdout;

/** Run a command and treat exit code 1 as a non-throwing status result. */
export const runWithStatus = async (command, args, env) => {
  try {
    return { stdout: await run(command, args, env), status: 0 };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      cause.code === 1 &&
      typeof cause.stdout === "string"
    )
      return { stdout: cause.stdout, status: 1 };
    throw cause;
  }
};

/** Parse JSON from a command output string. */
export const json = (text) => JSON.parse(text);

/** Check whether a path exists on disk. */
export const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};

/** Synthetic function dossier for managed/native verification fixtures. */
export const functionDossier = (name) => {
  const emptyPage = {
    items: [],
    total: 0,
    returned: 0,
    truncated: false,
    next_offset: null,
  };
  return {
    procedure: {
      address: "0x401000",
      name,
      classification: {
        external: false,
        thunk: false,
        thunk_target: null,
        provenance: "synthetic-provider",
      },
      signature: null,
      locals: [],
    },
    pseudocode: {
      text: "",
      total_chars: 0,
      returned_chars: 0,
      truncated: false,
      next_offset: null,
    },
    assembly: emptyPage,
    comments: emptyPage,
    callers: emptyPage,
    callees: emptyPage,
    incoming_references: emptyPage,
    outgoing_references: emptyPage,
    referenced_strings: emptyPage,
    referenced_names: emptyPage,
    basic_blocks: emptyPage,
    instruction_scan: { scanned: 0, truncated: false },
    limitations: [],
  };
};
