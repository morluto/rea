import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const bridgePath = fileURLToPath(
  new URL("../../../../bridge/hopper_bridge.py", import.meta.url),
);
const probePath = fileURLToPath(
  new URL("../../../fixtures/bridgeSearchProbe.py", import.meta.url),
);

const searchResultSchema = z.object({
  action: z.literal("search"),
  ok: z.literal(true),
  result: z.array(z.object({ address: z.string(), value: z.string() })),
});
const probeResultSchema = searchResultSchema;
type ProbeResult = z.infer<typeof probeResultSchema>;

type ProbeInput = {
  readonly action: "search";
  readonly items: readonly (readonly [string, string])[];
  readonly params: Readonly<Record<string, string | number | boolean>>;
};

interface PendingProbe {
  readonly resolve: (result: ProbeResult) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout | undefined;
}

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_BUFFER_LIMIT = 1_024 * 1_024;
const pendingProbes: PendingProbe[] = [];
let probeProcess: ChildProcessWithoutNullStreams | undefined;
let probeStdout = "";
let probeStderr = "";
let probeFailure: Error | undefined;
let stoppingProbe = false;

const failureWithStderr = (message: string): Error => {
  const stderr = probeStderr.trim();
  return new Error(stderr.length === 0 ? message : `${message}: ${stderr}`);
};

const rejectPendingProbes = (error: Error): void => {
  for (const pending of pendingProbes.splice(0)) {
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.reject(error);
  }
};

const failProbeProcess = (error: Error): void => {
  probeFailure ??= error;
  rejectPendingProbes(probeFailure);
  if (
    !stoppingProbe &&
    probeProcess?.exitCode === null &&
    probeProcess.signalCode === null
  )
    probeProcess.kill("SIGKILL");
};

const acceptProbeLine = (line: string): void => {
  const pending = pendingProbes.shift();
  if (pending === undefined) {
    failProbeProcess(
      failureWithStderr("Python probe returned an extra result"),
    );
    return;
  }
  if (pending.timeout !== undefined) clearTimeout(pending.timeout);
  try {
    const decoded: unknown = JSON.parse(line);
    pending.resolve(probeResultSchema.parse(decoded));
  } catch (cause: unknown) {
    const error =
      cause instanceof Error
        ? cause
        : failureWithStderr("Python probe returned an invalid result");
    pending.reject(error);
    failProbeProcess(error);
  }
};

const acceptProbeOutput = (chunk: string): void => {
  probeStdout += chunk;
  if (Buffer.byteLength(probeStdout) > PROBE_BUFFER_LIMIT) {
    failProbeProcess(failureWithStderr("Python probe output exceeded 1 MiB"));
    return;
  }
  let newline = probeStdout.indexOf("\n");
  while (newline >= 0) {
    const line = probeStdout.slice(0, newline).replace(/\r$/u, "");
    probeStdout = probeStdout.slice(newline + 1);
    acceptProbeLine(line);
    newline = probeStdout.indexOf("\n");
  }
};

const startProbeProcess = async (): Promise<void> => {
  stoppingProbe = false;
  probeFailure = undefined;
  probeStdout = "";
  probeStderr = "";
  const child = spawn("python3", [probePath, bridgePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  probeProcess = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", acceptProbeOutput);
  child.stderr.on("data", (chunk: string) => {
    probeStderr += chunk;
    if (Buffer.byteLength(probeStderr) > PROBE_BUFFER_LIMIT)
      failProbeProcess(new Error("Python probe stderr exceeded 1 MiB"));
  });
  child.stdin.on("error", (error) => {
    if (!stoppingProbe) failProbeProcess(error);
  });
  child.on("error", (error) => {
    if (!stoppingProbe) failProbeProcess(error);
  });
  child.on("exit", (code, signal) => {
    if (!stoppingProbe)
      failProbeProcess(
        failureWithStderr(
          `Python probe exited before responding (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
  });
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
};

const hasExited = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> => {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
};

const stopProbeProcess = async (): Promise<void> => {
  const child = probeProcess;
  if (child === undefined) return;
  stoppingProbe = true;
  rejectPendingProbes(new Error("Python probe stopped before responding"));
  if (!hasExited(child)) child.stdin.end();
  if (!(await waitForExit(child, 500))) child.kill("SIGTERM");
  if (!(await waitForExit(child, 500))) child.kill("SIGKILL");
  if (!(await waitForExit(child, 500)))
    throw new Error("Python probe did not stop after SIGKILL");
  probeProcess = undefined;
};

const probe = (input: ProbeInput): Promise<ProbeResult> => {
  const child = probeProcess;
  if (probeFailure !== undefined) return Promise.reject(probeFailure);
  if (child === undefined || hasExited(child))
    return Promise.reject(new Error("Python probe is not running"));
  return new Promise((resolve, reject) => {
    const pending: PendingProbe = { resolve, reject, timeout: undefined };
    pending.timeout = setTimeout(() => {
      failProbeProcess(
        new Error(
          `Python probe request timed out after ${String(PROBE_TIMEOUT_MS)} ms`,
        ),
      );
    }, PROBE_TIMEOUT_MS);
    pendingProbes.push(pending);
    child.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
      if (error !== null && error !== undefined) failProbeProcess(error);
    });
  });
};

beforeAll(startProbeProcess);
beforeEach(async () => {
  if (
    probeFailure === undefined &&
    probeProcess !== undefined &&
    !hasExited(probeProcess)
  )
    return;
  await stopProbeProcess();
  await startProbeProcess();
});
afterAll(stopProbeProcess);

describe.skipIf(process.platform === "win32")("Hopper bridge search", () => {
  it("returns matching literal values in deterministic order", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "REA_main_1"],
          ["0x2000", "unrelated"],
          ["0x3000", "rea_helper_42"],
        ],
        params: {
          pattern: "REA",
          mode: "literal",
          case_sensitive: false,
        },
      }),
    ).resolves.toEqual({
      action: "search",
      ok: true,
      result: [
        { address: "0x1000", value: "REA_main_1" },
        { address: "0x3000", value: "rea_helper_42" },
      ],
    });
  });

  it("returns matching entries for regex searches", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "REA_GHIDRA_INVENTORY_ENTRY"],
          ["0x2000", "unrelated"],
          ["0x3000", "REA_GHIDRA_LEAF_VALUE"],
        ],
        params: {
          pattern: "^REA_GHIDRA_(?:INVENTORY_ENTRY|LEAF_VALUE)$",
          mode: "regex",
          case_sensitive: true,
        },
      }),
    ).resolves.toEqual({
      action: "search",
      ok: true,
      result: [
        { address: "0x1000", value: "REA_GHIDRA_INVENTORY_ENTRY" },
        { address: "0x3000", value: "REA_GHIDRA_LEAF_VALUE" },
      ],
    });
  });

  it("returns the complete value for a long literal match", async () => {
    const value = `${"x".repeat(4_096)}needle`;
    await expect(
      probe({
        action: "search",
        items: [["0x1000", value]],
        params: {
          pattern: "needle",
          mode: "literal",
          case_sensitive: true,
        },
      }),
    ).resolves.toMatchObject({
      action: "search",
      ok: true,
      result: [{ address: "0x1000", value }],
    });
  });
});
