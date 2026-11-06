import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { execFileOutput } from "../ExecFileOutput.js";

const helperSource = fileURLToPath(
  new URL("../../../bridge/windows/ReaWindowsProcess.cs", import.meta.url),
);
const compiler = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);

const rowSchema = z.object({
  pid: z.number().int().nonnegative(),
  parent: z.number().int().nonnegative(),
  command: z.string(),
  start: z.string().nullable(),
});

export interface WindowsProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
  readonly startTime: string | undefined;
}

let helperExecutable: Promise<string> | undefined;

const compileHelper = (): Promise<string> => {
  helperExecutable ??= (async () => {
    const directory = join(tmpdir(), "rea-windows-process");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "ReaWindowsProcess.exe");
    if (!existsSync(compiler))
      throw new Error(`Windows process table requires csc.exe at ${compiler}`);
    await execFileOutput(
      compiler,
      [
        "/nologo",
        "/platform:x64",
        "/target:exe",
        `/out:${executable}`,
        helperSource,
      ],
      { timeout: 60_000 },
    );
    return executable;
  })();
  return helperExecutable;
};

/** Read pid, parent and image name without spawning ps. */
export const readWindowsProcessTable = async (
  signal?: AbortSignal,
): Promise<readonly WindowsProcessRow[]> => {
  const executable = await compileHelper();
  const output = await execFileOutput(executable, ["snapshot"], {
    timeout: 10_000,
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  });
  const parsed = z.array(rowSchema).parse(JSON.parse(output.stdout));
  return parsed.map((row) => ({
    pid: row.pid,
    parentPid: row.parent,
    command: row.command,
    startTime: row.start ?? undefined,
  }));
};

/** Read the capture token from the process environment block. */
export const readWindowsProcessRunId = async (
  pid: number,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const executable = await compileHelper();
  const output = await execFileOutput(executable, ["run-id", String(pid)], {
    timeout: 10_000,
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  });
  const value = output.stdout;
  return value.length === 0 ? undefined : value;
};
