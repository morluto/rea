import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const bridgePath = fileURLToPath(
  new URL("../bridge/hopper_bridge.py", import.meta.url),
);
const probePath = fileURLToPath(
  new URL("./fixtures/bridgeRegexProbe.py", import.meta.url),
);

const errorResultSchema = z.object({
  action: z.enum(["match", "search"]),
  ok: z.literal(false),
  type: z.string(),
  diagnostic_type: z.string(),
  message: z.string(),
});
const matchResultSchema = z.object({
  action: z.literal("match"),
  ok: z.literal(true),
  backtracking_paths: z.number().int().positive(),
  matched: z.boolean(),
});
const searchResultSchema = z.object({
  action: z.literal("search"),
  ok: z.literal(true),
  result: z.object({
    items: z.array(
      z.object({
        address: z.string(),
        value: z.string(),
        value_truncated: z.boolean(),
      }),
    ),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    next_offset: z.number().int().nonnegative().nullable(),
    has_more: z.boolean(),
  }),
});
const probeResultSchema = z.union([
  errorResultSchema,
  matchResultSchema,
  searchResultSchema,
]);
type ProbeResult = z.infer<typeof probeResultSchema>;

type ProbeInput =
  | {
      readonly action: "match";
      readonly pattern: string;
      readonly value: string;
      readonly case_sensitive?: boolean;
    }
  | {
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

const invalidRequest = (action: "match" | "search", message: string) => ({
  action,
  ok: false,
  type: "ValueError",
  diagnostic_type: "invalid_request",
  message,
});

describe("Hopper bridge regex bounds", () => {
  it("accepts useful patterns whose static backtracking budget is bounded", async () => {
    await expect(
      probe({
        action: "match",
        pattern: String.raw`^rea_(?:main|helper)_[0-9]{1,3}$`,
        value: "REA_helper_42",
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 6,
      matched: true,
    });
  });

  it("applies bounded regex matching through deterministic pagination", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "REA_main_1"],
          ["0x2000", "unrelated"],
          ["0x3000", "rea_helper_42"],
        ],
        params: {
          pattern: String.raw`^rea_(?:main|helper)_[0-9]{1,3}$`,
          mode: "regex",
          case_sensitive: false,
          offset: 1,
          limit: 1,
        },
      }),
    ).resolves.toEqual({
      action: "search",
      ok: true,
      result: {
        items: [
          {
            address: "0x3000",
            value: "rea_helper_42",
            value_truncated: false,
          },
        ],
        offset: 1,
        limit: 1,
        total: 2,
        next_offset: null,
        has_more: false,
      },
    });
  });

  it.each([
    [
      "lookaround",
      "(?=a)a",
      "Regex lookarounds and backreferences are not supported",
    ],
    [
      "backreference",
      String.raw`(a)\1`,
      "Regex lookarounds and backreferences are not supported",
    ],
    [
      "nested repeat",
      "(a{1,2}){1,2}",
      "Nested regex repetitions are not supported",
    ],
    [
      "unbounded repeat",
      "a+",
      "Unbounded or excessive regex repetitions are not supported",
    ],
    [
      "excessive repeat",
      "a{1001}",
      "Unbounded or excessive regex repetitions are not supported",
    ],
  ])("rejects unsupported %s constructs", async (_name, pattern, message) => {
    await expect(
      probe({ action: "match", pattern, value: "aaaa", case_sensitive: true }),
    ).resolves.toEqual(invalidRequest("match", message));
  });

  it.each(["(", "a{999999999999999999999999}"])(
    "normalizes parser failure %s through the search boundary",
    async (pattern) => {
      await expect(
        probe({
          action: "search",
          items: [],
          params: { pattern, mode: "regex", offset: 0, limit: 1 },
        }),
      ).resolves.toEqual(invalidRequest("search", "Invalid regex pattern"));
    },
  );

  it("accepts the maximum bounded repeat at the exact work budget", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "a{1000}",
        value: "a".repeat(1_000),
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 1,
      matched: true,
    });
  });

  it("accepts expensive matching just below the cumulative work limit", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(?:a|aa){1,8}b",
        value: "a".repeat(115),
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 510,
      matched: false,
    });
  });

  it("rejects ambiguous bounded repetition before Python regex execution", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(a|aa){1,35}b",
        value: "a".repeat(35),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex exceeds the 10000-path backtracking budget",
      ),
    );
  });

  it("rejects excessive combinations across adjacent optional atoms", async () => {
    await expect(
      probe({
        action: "match",
        pattern: `${"a?".repeat(14)}b`,
        value: "a".repeat(14),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex exceeds the 10000-path backtracking budget",
      ),
    );
  });

  it("bounds cumulative work before evaluating a costly candidate", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(?:a|aa){1,12}b",
        value: "a".repeat(4_096),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex search exceeds the 1000000-unit work budget",
      ),
    );
  });

  it("applies the regex work budget across the full inventory", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "a".repeat(60)],
          ["0x2000", "a".repeat(60)],
        ],
        params: {
          pattern: "(?:a|aa){1,8}b",
          mode: "regex",
          case_sensitive: true,
          offset: 0,
          limit: 1,
        },
      }),
    ).resolves.toEqual(
      invalidRequest(
        "search",
        "Regex search exceeds the 1000000-unit work budget",
      ),
    );
  });

  it("rejects oversized regex candidates instead of matching a prefix", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "needle",
        value: `${"x".repeat(4_096)}needle`,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex candidate exceeds the 4096-character safety limit",
      ),
    );
  });

  it("accepts a regex candidate at the exact character limit", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "z$",
        value: `${"a".repeat(4_095)}z`,
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 1,
      matched: true,
    });
  });

  it.each([
    [256, true],
    [257, false],
  ])("enforces the %i-character pattern boundary", async (length, accepted) => {
    const pattern = "a".repeat(length);
    const result = await probe({
      action: "search",
      items: [["0x1000", pattern]],
      params: {
        pattern,
        mode: "regex",
        case_sensitive: true,
        offset: 0,
        limit: 1,
      },
    });
    if (accepted) {
      expect(result).toMatchObject({
        action: "search",
        ok: true,
        result: { total: 1 },
      });
      return;
    }
    expect(result).toEqual(
      invalidRequest(
        "search",
        "pattern must contain between 1 and 256 characters",
      ),
    );
  });

  it("keeps literal matching exhaustive while bounding returned text", async () => {
    const result = await probe({
      action: "search",
      items: [["0x1000", `${"x".repeat(4_096)}needle`]],
      params: {
        pattern: "needle",
        mode: "literal",
        case_sensitive: true,
        offset: 0,
        limit: 1,
      },
    });
    expect(result).toMatchObject({
      action: "search",
      ok: true,
      result: {
        total: 1,
        has_more: false,
        items: [{ address: "0x1000", value_truncated: true }],
      },
    });
    if (result.action === "search" && result.ok)
      expect(result.result.items[0]?.value).toHaveLength(4_096);
  });
});
