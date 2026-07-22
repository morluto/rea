import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HopperStartupDiagnostic } from "../src/domain/hopperStartupFailure.js";
import {
  runLinuxPrivateDisplayProbe,
  selectLinuxPrivateDisplayStrategy,
  type LinuxPrivateDisplayProbeProcessResult,
  type LinuxPrivateDisplayProbeRunner,
  type LinuxPrivateDisplayRunnableStrategy,
} from "../src/hopper/LinuxPrivateDisplayProbe.js";
import {
  LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX,
  parseLinuxPrivateDisplayDiagnostic,
} from "../src/hopper/LinuxPrivateDisplayDiagnostic.js";

const helperPath = fileURLToPath(
  new URL("../scripts/hopper-demo-x11.py", import.meta.url),
);
const hangingHelperPath = fileURLToPath(
  new URL("./fixtures/x11ProbeHang.py", import.meta.url),
);

const diagnostic = (
  overrides: Partial<HopperStartupDiagnostic> = {},
): HopperStartupDiagnostic => ({
  schema_version: 1,
  component: "hopper_private_display",
  operation: "probe",
  status: "ready",
  failure_code: null,
  reason: "ready",
  socket_directory: "/tmp/.X11-unix",
  socket_directory_mode: "1777",
  mount_read_only: false,
  effective_socket_directory_mode: "1777",
  effective_mount_read_only: false,
  wsl: false,
  strategy: "direct",
  fallback_reason: null,
  xvfb_stderr_bytes: 0,
  xvfb_stderr_truncated: false,
  ...overrides,
});

const processResult = (
  value: HopperStartupDiagnostic,
  overrides: Partial<LinuxPrivateDisplayProbeProcessResult> = {},
): LinuxPrivateDisplayProbeProcessResult => ({
  exitCode: value.status === "ready" ? 0 : failureExit(value.failure_code),
  stderr: `${LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX}${JSON.stringify(value)}\n`,
  stderrBytes: 0,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  cleanupIncomplete: false,
  ...overrides,
});

const failureExit = (code: HopperStartupDiagnostic["failure_code"]): number =>
  code === "x11_socket_directory_unusable"
    ? 80
    : code === "runtime_dependency_unavailable"
      ? 79
      : 70;

describe("Linux private display selection", () => {
  it("prefers a successful direct Xvfb probe", async () => {
    const calls: LinuxPrivateDisplayRunnableStrategy[] = [];
    const runProbe: LinuxPrivateDisplayProbeRunner = (strategy) => {
      calls.push(strategy);
      return Promise.resolve(processResult(diagnostic({ strategy })));
    };

    await expect(
      selectLinuxPrivateDisplayStrategy({ helperPath, runProbe }),
    ).resolves.toMatchObject({ ok: true, strategy: "direct" });
    expect(calls).toEqual(["direct"]);
  });

  it("uses a private mount namespace only for the exact socket conflict", async () => {
    const calls: LinuxPrivateDisplayRunnableStrategy[] = [];
    const runProbe: LinuxPrivateDisplayProbeRunner = (strategy) => {
      calls.push(strategy);
      return Promise.resolve(
        strategy === "direct"
          ? processResult(
              diagnostic({
                strategy,
                status: "error",
                failure_code: "x11_socket_directory_unusable",
                reason: "socket_directory_read_only",
                socket_directory_mode: "0777",
                mount_read_only: true,
                effective_socket_directory_mode: "0777",
                effective_mount_read_only: true,
                wsl: true,
              }),
            )
          : processResult(diagnostic({ strategy, wsl: true })),
      );
    };

    const selected = await selectLinuxPrivateDisplayStrategy({
      helperPath,
      runProbe,
    });
    expect(selected).toMatchObject({
      ok: true,
      strategy: "user-mount-namespace",
      diagnostic: {
        socket_directory_mode: "0777",
        mount_read_only: true,
        effective_socket_directory_mode: "1777",
        effective_mount_read_only: false,
        wsl: true,
      },
    });
    expect(calls).toEqual(["direct", "user-mount-namespace"]);
  });

  it.each([
    ["missing_xvfb", "runtime_dependency_unavailable", 79],
    ["address_collision", "private_display_unavailable", 70],
  ] as const)(
    "does not mask deterministic direct failure %s with a namespace probe",
    async (reason, failureCode, exitCode) => {
      const calls: LinuxPrivateDisplayRunnableStrategy[] = [];
      const runProbe: LinuxPrivateDisplayProbeRunner = (strategy) => {
        calls.push(strategy);
        return Promise.resolve(
          processResult(
            diagnostic({
              strategy,
              status: "error",
              failure_code: failureCode,
              reason,
            }),
            { exitCode },
          ),
        );
      };
      await expect(
        selectLinuxPrivateDisplayStrategy({ helperPath, runProbe }),
      ).resolves.toMatchObject({ ok: false, exitCode });
      expect(calls).toEqual(["direct"]);
    },
  );

  it.each([
    [
      "malformed",
      `${LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX}not-json`,
      false,
      "diagnostic_malformed",
    ],
    [
      "oversized",
      `${LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX}${"x".repeat(70_000)}`,
      true,
      "diagnostic_truncated",
    ],
  ] as const)(
    "rejects %s helper diagnostics",
    async (_name, stderr, stderrTruncated, reason) => {
      const runProbe: LinuxPrivateDisplayProbeRunner = () =>
        Promise.resolve({
          ...processResult(diagnostic()),
          exitCode: 70,
          stderr,
          stderrTruncated,
        });
      await expect(
        selectLinuxPrivateDisplayStrategy({ helperPath, runProbe }),
      ).resolves.toMatchObject({
        ok: false,
        diagnostic: { reason },
      });
    },
  );

  it("reports missing helper dependencies without exposing raw stderr", () => {
    for (const [option, reason] of [
      ["--xauth", "missing_xauth"],
      ["--xvfb", "missing_xvfb"],
    ] as const) {
      const result = spawnSync(
        "/usr/bin/python3",
        [helperPath, "--probe", option, "/rea/missing-executable"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(79);
      const parsed = parseLinuxPrivateDisplayDiagnostic(result.stderr, false);
      expect(parsed).toMatchObject({
        ok: true,
        value: {
          status: "error",
          failure_code: "runtime_dependency_unavailable",
          reason,
        },
      });
      expect(result.stderr).not.toContain("Traceback");
    }
  });

  it("kills the owned probe group when its absolute deadline expires", async () => {
    const result = await selectLinuxPrivateDisplayStrategy({
      helperPath: hangingHelperPath,
      timeoutMs: 75,
      runProbe: runLinuxPrivateDisplayProbe,
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostic: { reason: "probe_timeout" },
    });
    const processes = spawnSync("/bin/ps", ["-eo", "args="], {
      encoding: "utf8",
    }).stdout;
    expect(processes).not.toContain(hangingHelperPath);
  });
});
