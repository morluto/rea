import { spawn } from "node:child_process";

import type { ReplayExecutionResult } from "../domain/javascriptReplay.js";

export interface CollectedProcess {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputExceeded: boolean;
}

export const boundedCollector = (maximum: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  return {
    append: (chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, maximum - bytes));
      if (retained.byteLength > 0) chunks.push(retained);
      bytes += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) overflow = true;
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
    exceeded: () => overflow,
  };
};

export const collect = async (
  executable: string,
  arguments_: readonly string[],
  maximum: number,
) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = boundedCollector(maximum);
      const stderr = boundedCollector(maximum);
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timeout.unref();
      child.stdout?.on("data", stdout.append);
      child.stderr?.on("data", stderr.append);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout: stdout.value(), stderr: stderr.value() });
      });
    },
  );

export const killUnit = async (
  systemctl: string,
  unit: string,
): Promise<void> => {
  try {
    await collect(
      systemctl,
      ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
      4096,
    );
  } catch {
    /* cleanup continues */
  }
};

export const observeCleanup = async (
  systemctl: string,
  unit: string,
): Promise<ReplayExecutionResult["cleanup"]> => {
  try {
    const state = await collect(
      systemctl,
      ["--user", "show", "--property=ActiveState", "--value", unit],
      4096,
    );
    const activeState = state.stdout.trim();
    if (
      state.code !== 0 ||
      activeState === "inactive" ||
      activeState === "failed" ||
      activeState.length === 0
    ) {
      await collect(systemctl, ["--user", "reset-failed", unit], 4096);
      return { state: "complete", residual_resources: [] };
    }
    return { state: "incomplete", residual_resources: [unit] };
  } catch {
    return { state: "incomplete", residual_resources: [unit] };
  }
};

export const observeUnitResult = async (
  systemctl: string,
  unit: string,
): Promise<string> => {
  try {
    const result = await collect(
      systemctl,
      ["--user", "show", "--property=Result", "--value", unit],
      4096,
    );
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
};
