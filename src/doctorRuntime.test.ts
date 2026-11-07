import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test, vi } from "vitest";
import { withVerifierCleanup } from "../scripts/lib/verifier-cleanup.mjs";
import { awaitAcknowledgement } from "../tests/fixtures/lifecycleAcknowledgement.js";

import {
  createSystemDoctorHost,
  selectedProviderSettings,
  settingAffectsProbe,
} from "./doctorRuntime.js";
import { DOCTOR_PROVIDER_IDS } from "./application/DoctorProviderIds.js";
import { providerRegistrationEnvironment } from "./application/SetupRegistrationEnvironment.js";
import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import { writeJadxJarInventory } from "../tests/fixtures/android/jadxJar.js";
import * as privateDisplay from "./hopper/LinuxPrivateDisplayProbe.js";
import * as pythonRuntime from "./application/LinuxHopperPython.js";
import { err, ok } from "./domain/result.js";
import { AnalysisError } from "./domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "./domain/analysisErrorCore.js";
import { createDoctorHostFixture } from "./application/Doctor.fixture.js";
import { runDoctor, runDoctorOwned } from "./application/Doctor.js";
import { waitForAbortable } from "./process/AbortablePromise.js";
import { AnalysisCleanupLease } from "./artifacts/AnalysisCleanupLease.js";
import { CURRENT_ENTRYPOINT_PATH } from "./process/CurrentEntrypointPath.js";
import * as configurationFiles from "./application/ClientConfigurationFiles.js";
import { RegularFileCleanupFailure } from "./filesystem/OwnedRegularFile.js";

const readyDisplay = {
  ok: true,
  strategy: "direct",
  diagnostic: {
    component: "hopper_private_display",
    operation: "probe",
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
    status: "ready",
    failure_code: null,
  },
} as const satisfies privateDisplay.LinuxPrivateDisplaySelection;

test.each([undefined, "controlled close refusal"])(
  "propagates runtime-probe cancellation through owned doctor cleanup: %s",
  async (cleanupFailure) => {
    const controller = new AbortController();
    const reason = { request: "cancel Python runtime inspection" };
    const display = vi
      .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
      .mockResolvedValue(readyDisplay);
    const python = vi
      .spyOn(pythonRuntime, "inspectLinuxHopperPythonRuntime")
      .mockImplementation(async (_environment, signal) => {
        expect(signal?.aborted).toBe(false);
        controller.abort(reason);
        expect(signal?.reason).toBe(reason);
        return err(
          new pythonRuntime.LinuxHopperPythonError(
            "cancelled",
            "Controlled runtime cancellation",
            reason,
          ),
        );
      });
    const systemHost = createSystemDoctorHost({}, controller.signal);
    const close = vi.fn(async () => {
      await systemHost.close?.();
      return cleanupFailure;
    });
    try {
      const failure = await runDoctorOwned(
        undefined,
        createDoctorHostFixture({
          platform: "linux",
          configuredHopperPath: "/fixture/Hopper",
          signal: controller.signal,
          linuxDemoRuntimeCheck: systemHost.linuxDemoRuntimeCheck,
          close,
        }),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!(failure instanceof AnalysisError))
        throw new Error("Expected a doctor cancellation failure");
      const primary = failure.cleanupPrimary ?? failure;
      expect(primary).toBeInstanceOf(AnalysisCancelledError);
      expect(primary.cause).toBe(reason);
      expect(primary.diagnostics).toMatchObject({
        hopper_demo_runtime: {
          private_display: readyDisplay.diagnostic,
          embedded_python: { status: "unknown", reason: "cancelled" },
        },
      });
      expect(close).toHaveBeenCalledTimes(1);
      if (cleanupFailure === undefined) expect(failure).toBe(primary);
      else expect(failure.cleanupIncomplete).toBe(true);
    } finally {
      try {
        await systemHost.close?.();
      } finally {
        python.mockRestore();
        display.mockRestore();
      }
    }
  },
);

test("retains a failed display-probe owner until doctor closure confirms release", async () => {
  let released = false;
  const lease = new AnalysisCleanupLease(async () => {
    if (!released) throw new Error("Fixture probe remains owned");
  }, ["fixture-private-display-probe"]);
  const display = vi
    .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
    .mockResolvedValue({
      ok: false,
      strategy: "unavailable",
      exitCode: 70,
      diagnostic: {
        ...readyDisplay.diagnostic,
        status: "error",
        failure_code: "private_display_unavailable",
        strategy: "unavailable",
        reason: "probe_timeout",
      },
      cleanup: {
        status: "pending",
        lease,
        reason: "Fixture probe remains owned",
      },
    });
  const host = createSystemDoctorHost({});
  try {
    const failure = await host.linuxDemoRuntimeCheck().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected retained probe cleanup failure");
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual(["fixture-private-display-probe"]);
    await expect(host.close?.()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(failure.cleanupIncomplete).toBe(true);
    released = true;
    expect(await host.close?.()).toBeUndefined();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
  } finally {
    released = true;
    await host.close?.();
    display.mockRestore();
  }
});

test.each(["unavailable", "unknown"] as const)(
  "does not report a healthy Hopper runtime when Python is %s",
  async (state) => {
    const display = vi
      .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
      .mockResolvedValue(readyDisplay);
    const python = vi
      .spyOn(pythonRuntime, "inspectLinuxHopperPythonRuntime")
      .mockResolvedValue(
        state === "unavailable"
          ? ok({
              interpreter: "/usr/bin/python3",
              version: [3, 14],
              library: {
                status: "unavailable",
                path: "/usr/lib/libpython3.14.so.1.0",
                reason: "No such file",
              },
            })
          : err(
              new pythonRuntime.LinuxHopperPythonError(
                "query_failed",
                "Fixture query failed",
              ),
            ),
      );
    try {
      const check = await createSystemDoctorHost({}).linuxDemoRuntimeCheck?.();
      expect(check).toMatchObject({
        name: "hopper-demo-runtime",
        ok: false,
        classification:
          state === "unavailable" ? "missing_dependency" : "unknown",
        details: {
          private_display: readyDisplay.diagnostic,
          embedded_python: {
            scope: "system_interpreter",
            hopper_interpreter: "unknown",
            ...(state === "unavailable"
              ? { status: "observed", library: { status: "unavailable" } }
              : { status: "unknown", reason: "query_failed" }),
          },
        },
      });
      expect(check?.remediation).toContain(
        state === "unavailable"
          ? "rea setup --install-hopper"
          : "Retry rea doctor",
      );
    } finally {
      python.mockRestore();
      display.mockRestore();
    }
  },
);

test.each([true, false])(
  "interrupts the Hopper display readiness check when doctor is cancelled: cancel=%s",
  async (cancel) => {
    const controller = new AbortController();
    const reason = { request: "cancel doctor display check" };
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = vi
      .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
      .mockImplementation(async (options) => {
        enter();
        await waitForAbortable(gate, options.signal);
        return readyDisplay;
      });
    const inspected = vi
      .spyOn(pythonRuntime, "inspectLinuxHopperPythonRuntime")
      .mockImplementation(async (_environment, signal) =>
        signal?.aborted === true
          ? err(
              new pythonRuntime.LinuxHopperPythonError(
                "cancelled",
                "Fixture cancellation",
                signal.reason,
              ),
            )
          : ok({
              interpreter: "/usr/bin/python3",
              version: [3, 14],
              library: {
                status: "loadable",
                path: "/fixture/libpython.so",
              },
            }),
      );
    const system = createSystemDoctorHost({}, controller.signal);
    let settled = false;
    const pending = runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        platform: "linux",
        configuredHopperPath: "/fixture/Hopper",
        signal: controller.signal,
        linuxDemoRuntimeCheck: system.linuxDemoRuntimeCheck,
        close: async () => {
          await system.close?.();
          return undefined;
        },
      }),
      { providers: ["hopper"] },
    )
      .then(
        (report) => ({ report, error: undefined }),
        (error: unknown) => ({ report: undefined, error }),
      )
      .finally(() => {
        settled = true;
      });
    await withVerifierCleanup(async () => {
      await awaitAcknowledgement(entered, pending, "display selection");
      expect(selected.mock.calls).toHaveLength(1);
      if (cancel) {
        controller.abort(reason);
        const result = await pending;
        const selectedSignal = selected.mock.calls[0]?.[0].signal;
        expect(selectedSignal?.aborted).toBe(true);
        expect(selectedSignal?.reason).toBe(reason);
        expect(inspected).not.toHaveBeenCalled();
        expect(result.error).toBeInstanceOf(AnalysisCancelledError);
        expect((result.error as Error).cause).toBe(reason);
      } else {
        expect(settled).toBe(false);
        expect(inspected).not.toHaveBeenCalled();
        release();
        const result = await pending;
        expect(result.error).toBeUndefined();
        expect(result.report?.checks).toContainEqual(
          expect.objectContaining({ name: "hopper-demo-runtime", ok: true }),
        );
      }
    }, [
      release,
      async () => {
        await pending;
      },
      async () => {
        await system.close?.();
      },
      () => inspected.mockRestore(),
      () => selected.mockRestore(),
    ]);
  },
  5_000,
);

test("joins display finalization before preserving a late cancellation", async () => {
  const controller = new AbortController();
  const reason = { phase: "display finalization" };
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const finalized = new Promise<void>((resolve) => {
    release = resolve;
  });
  const selected = vi
    .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
    .mockImplementation(async () => {
      // Controlled selector finalization: cancellation must not detach this wait.
      enter();
      await finalized;
      return readyDisplay;
    });
  const inspected = vi
    .spyOn(pythonRuntime, "inspectLinuxHopperPythonRuntime")
    .mockRejectedValue(
      new Error("Python inspection must not start after cancellation"),
    );
  const system = createSystemDoctorHost({}, controller.signal);
  let settled = false;
  const pending = system.linuxDemoRuntimeCheck!()
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  await withVerifierCleanup(async () => {
    await awaitAcknowledgement(entered, pending, "display finalization");
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inspected).not.toHaveBeenCalled();
    release();
    const failure = await pending;
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect((failure as Error).cause).toBe(reason);
    expect(inspected).not.toHaveBeenCalled();
  }, [
    release,
    async () => {
      await pending;
    },
    async () => {
      await system.close?.();
    },
    () => inspected.mockRestore(),
    () => selected.mockRestore(),
  ]);
});

test("rejects a pre-aborted caller before the Hopper display check", async () => {
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const runtime = vi.fn();
  await expect(
    runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        platform: "linux",
        signal: controller.signal,
        linuxDemoRuntimeCheck: runtime,
      }),
    ),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(runtime).not.toHaveBeenCalled();
});

test("preserves both X11 and Python failures and their independent remediation", async () => {
  const display = vi
    .spyOn(privateDisplay, "selectLinuxPrivateDisplayStrategy")
    .mockResolvedValue({
      ok: false,
      strategy: "unavailable",
      exitCode: 80,
      diagnostic: {
        ...readyDisplay.diagnostic,
        status: "error",
        failure_code: "x11_socket_directory_unusable",
      },
    });
  const python = vi
    .spyOn(pythonRuntime, "inspectLinuxHopperPythonRuntime")
    .mockResolvedValue(
      ok({
        interpreter: "/usr/bin/python3",
        version: [3, 14],
        library: { status: "unknown", reason: "No INSTSONAME" },
      }),
    );
  try {
    const check = await createSystemDoctorHost({}).linuxDemoRuntimeCheck?.();
    expect(check).toMatchObject({
      ok: false,
      classification: "config_drift",
      details: {
        private_display: { failure_code: "x11_socket_directory_unusable" },
        embedded_python: { status: "observed", library: { status: "unknown" } },
      },
    });
    expect(check?.remediation).toContain("user and mount namespaces");
    expect(check?.remediation).toContain("shared-runtime configuration");
  } finally {
    python.mockRestore();
    display.mockRestore();
  }
});

const it = test.skipIf(process.platform === "win32");

it("exposes jadx through the doctor provider selector", () => {
  expect(DOCTOR_PROVIDER_IDS).toContain("jadx");
});

it("carries a validated REA_JADX_MCP_JAR into the provider registration environment", async () => {
  const root = await createTestTempDirectory("rea-jadx-registration-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = await createFakeJdk(root);
  await writeJadxJarInventory(jar);

  const host = createSystemDoctorHost({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: javaHome,
  });
  const inspections = await host.providerInspections?.([]);
  expect(inspections?.map(({ id }) => id)).toContain("jadx");

  const environment = providerRegistrationEnvironment(inspections ?? []);
  expect(environment).toMatchObject({
    REA_JADX_MCP_JAR: await realpath(jar),
  });
});

it("omits REA_JADX_MCP_JAR from the provider registration environment when it is not configured", async () => {
  const host = createSystemDoctorHost({});
  const inspections = await host.providerInspections?.([]);

  const environment = providerRegistrationEnvironment(inspections ?? []);
  expect(environment).not.toHaveProperty("REA_JADX_MCP_JAR");
});

it("shares one parsed IDA registration between timeout-budget and doctor projections", async () => {
  const root = await createTestTempDirectory("rea-ida-registration-fact-");
  const registration = join(root, "registration.json");
  await writeFile(
    registration,
    JSON.stringify({ command: "fixture", timeoutMs: 3210 }),
  );
  const host = createSystemDoctorHost({ REA_IDA_MCP_CONFIG: registration });
  try {
    expect(
      await host.resolveProviderRequestBudget?.("ida", {
        REA_IDA_MCP_CONFIG: registration,
      }),
    ).toEqual(ok(3210));
    await writeFile(registration, "not JSON anymore");
    const inspections = await host.providerInspections?.([]);
    expect(inspections?.find(({ id }) => id === "ida")).toMatchObject({
      configured: true,
      available: true,
      checks: [{ name: "registration", ok: true }],
    });
  } finally {
    await host.close?.();
  }
});

it("carries a validated REA_KUNA_COMMAND into the provider registration environment", async () => {
  expect(DOCTOR_PROVIDER_IDS).toContain("kuna");
  const root = await createTestTempDirectory("rea-kuna-registration-");
  const kuna = join(root, "kuna");
  await writeFile(kuna, "#!/bin/sh\nprintf 'kuna 1.833\\n'\n", { mode: 0o700 });

  const inspections = await createSystemDoctorHost({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: join(root, "cache"),
  }).providerInspections?.([]);

  expect(inspections?.find(({ id }) => id === "kuna")).toMatchObject({
    available: true,
    providerVersion: "1.833",
  });
  expect(providerRegistrationEnvironment(inspections ?? [])).toMatchObject({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: join(root, "cache"),
  });
});

const createFakeJdk = async (root: string): Promise<string> => {
  const javaHome = join(root, "fake-jdk");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  await mkdir(bin, { recursive: true });
  await writeFile(
    java,
    "#!/bin/sh\nprintf 'java.base@21\\njdk.compiler@21\\n'\n",
  );
  await chmod(java, 0o700);
  return javaHome;
};

const opencodeRegistration = (
  home: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> => {
  const directory = join(home, ".config/opencode");
  return mkdir(directory, { recursive: true }).then(() =>
    writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: {
          rea: {
            type: "local",
            command: [process.execPath, CURRENT_ENTRYPOINT_PATH, "mcp"],
            enabled: true,
            environment,
          },
        },
      }),
    ),
  );
};

test("probes the selected client's registration environment instead of the terminal's", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-env-");
  await opencodeRegistration(home, {
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
    REA_JADX_MCP_JAR: "/opt/jadx.jar",
  });
  const host = createSystemDoctorHost({ HOME: home });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test("keeps reading this terminal when no client is selected", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-ambient-");
  await opencodeRegistration(home, { GHIDRA_INSTALL_DIR: "/opt/ghidra" });
  const host = createSystemDoctorHost({ HOME: home });
  try {
    const inspections = await host.providerInspections?.([]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      false,
    );
  } finally {
    await host.close?.();
  }
});

test("keeps a selected client without a registration on the setup's settings", async () => {
  const home = await createTestTempDirectory(
    "rea-opencode-doctor-unregistered-",
  );
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
  } finally {
    await host.close?.();
  }
});

test("decides whether an unresolved setting is one the probe actually reads", () => {
  // JADX resolves Java from an explicit JAVA_HOME, so a PATH it never consults
  // must not make the whole provider unknown.
  expect(
    settingAffectsProbe("jadx", "PATH", { JAVA_HOME: "/opt/java" }, "linux"),
  ).toBe(false);
  expect(settingAffectsProbe("jadx", "PATH", {}, "linux")).toBe(true);
  expect(
    settingAffectsProbe(
      "jadx",
      "JAVA_HOME",
      { JAVA_HOME: "/opt/java" },
      "linux",
    ),
  ).toBe(true);
  // Ghidra still looks either the install directory or the JDK up on PATH.
  expect(
    settingAffectsProbe(
      "ghidra",
      "PATH",
      { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      "linux",
    ),
  ).toBe(true);
  expect(
    settingAffectsProbe(
      "ghidra",
      "PATH",
      { GHIDRA_INSTALL_DIR: "/opt/ghidra", JAVA_HOME: "/opt/java" },
      "linux",
    ),
  ).toBe(false);
  // Kuna's cache root falls back to XDG_CACHE_HOME off Darwin and to HOME.
  expect(settingAffectsProbe("kuna", "XDG_CACHE_HOME", {}, "linux")).toBe(true);
  expect(settingAffectsProbe("kuna", "XDG_CACHE_HOME", {}, "darwin")).toBe(
    false,
  );
  expect(
    settingAffectsProbe(
      "kuna",
      "HOME",
      { REA_KUNA_CACHE_DIR: "/opt/cache" },
      "linux",
    ),
  ).toBe(false);
});

test("lets a selected client keep the terminal settings its registration omits", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-overlay-");
  await opencodeRegistration(home, { REA_JADX_MCP_JAR: "/opt/jadx.jar" });
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test("does not fill a registration's unresolvable expression from the terminal", async () => {
  const home = await createTestTempDirectory("rea-dsh-doctor-expression-");
  // Harness keeps a Cordis expression in the patch, so this process cannot
  // know what the client passes on; the terminal is not that value.
  await mkdir(join(home, ".dsh"), { recursive: true });
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    [
      "- insert:",
      "    - id: rea-mcp",
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      "        serverName: rea",
      "        transport: stdio",
      "        command: rea",
      "        args: [mcp]",
      "        env:",
      "          GHIDRA_INSTALL_DIR: !!js caller.ghidra",
      "          REA_JADX_MCP_JAR: /opt/jadx.jar",
      "",
    ].join("\n"),
    { flag: "w" },
  );
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["dsh"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: null,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test.each([["win32"], ["linux"]] as const)(
  "folds a registration's spelling into the names a provider check reads: platform=%s",
  (platform) => {
    const settings = selectedProviderSettings(
      {
        environment: {
          ghidra_install_dir: "/opt/ghidra",
          rea_jadx_mcp_jar: "/opt/jadx.jar",
        },
        unresolved: new Set(["rea_ghidra_startup_timeout_ms"]),
      },
      {
        GHIDRA_INSTALL_DIR: "/terminal/ghidra",
        REA_JADX_MCP_JAR: "/terminal/jadx.jar",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "60000",
        OTHER: "kept",
      },
      platform,
    );
    if (platform === "win32") {
      expect(settings).toEqual({
        GHIDRA_INSTALL_DIR: "/opt/ghidra",
        REA_JADX_MCP_JAR: "/opt/jadx.jar",
        OTHER: "kept",
      });
    } else {
      // POSIX names are case-sensitive: the lowercase registration keys are
      // separate settings and the terminal's uppercase ones survive.
      expect(settings).toEqual({
        GHIDRA_INSTALL_DIR: "/terminal/ghidra",
        REA_JADX_MCP_JAR: "/terminal/jadx.jar",
        ghidra_install_dir: "/opt/ghidra",
        rea_ghidra_startup_timeout_ms: undefined,
        rea_jadx_mcp_jar: "/opt/jadx.jar",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "60000",
        OTHER: "kept",
      });
    }
  },
);

test("retains a failed registration-file close returned as a read error", async () => {
  const home = await createTestTempDirectory("rea-doctor-registration-close-");
  const close = vi.fn().mockResolvedValue(undefined);
  const path = join(home, ".config/opencode/opencode.json");
  const failure = new RegularFileCleanupFailure({
    path,
    owner: { close } as never,
    outcome: { kind: "failed", cause: new Error("read failed") },
    cleanupCause: new Error("close failed"),
  });
  const read = vi
    .spyOn(configurationFiles, "readEffectiveClientRegistrationConfiguration")
    .mockResolvedValue(
      err({
        kind: "unreadable",
        path,
        detail: "unreadable",
        cleanupFailure: failure,
      }),
    );
  const host = createSystemDoctorHost({ HOME: home });
  try {
    await host.providerInspections?.(["opencode"]);
    await host.close?.();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
    await host.close?.();
  }
});

test("retries a retained registration-file close after a failed retry", async () => {
  const home = await createTestTempDirectory(
    "rea-doctor-registration-close-retry-",
  );
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("close still failed"))
    .mockResolvedValue(undefined);
  const path = join(home, ".config/opencode/opencode.json");
  const failure = new RegularFileCleanupFailure({
    path,
    owner: { close } as never,
    outcome: { kind: "failed", cause: new Error("read failed") },
    cleanupCause: new Error("close failed"),
  });
  const read = vi
    .spyOn(configurationFiles, "readEffectiveClientRegistrationConfiguration")
    .mockResolvedValue(
      err({
        kind: "unreadable",
        path,
        detail: "unreadable",
        cleanupFailure: failure,
      }),
    );
  const host = createSystemDoctorHost({ HOME: home });
  try {
    await host.providerInspections?.(["opencode"]).catch(() => undefined);
    await host.close?.().catch(() => undefined);
    await host.close?.();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    await host.close?.();
  }
});

test("does not use terminal readiness when a selected registration is malformed", async () => {
  const home = await createTestTempDirectory(
    "rea-doctor-malformed-registration-",
  );
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await writeFile(join(home, ".config/opencode/opencode.json"), "not JSON");
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: null,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
    const report = await runDoctor(undefined, host, {
      clients: ["opencode"],
      providers: ["ghidra"],
    });
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "ghidra",
        ok: false,
        classification: "unknown",
      }),
    );
    expect(report.scope_checks).not.toContainEqual(
      expect.objectContaining({
        name: "provider:ghidra",
        classification: "missing_analysis_engine",
      }),
    );
  } finally {
    await host.close?.();
  }
});

test("keeps a known provider configuration when only its Java setting is unresolved", async () => {
  const home = await createTestTempDirectory("rea-dsh-doctor-partial-");
  await mkdir(join(home, ".dsh"), { recursive: true });
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    [
      "- insert:",
      "    - id: rea-mcp",
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      "        serverName: rea",
      "        transport: stdio",
      "        command: rea",
      "        args: [mcp]",
      "        env:",
      "          GHIDRA_INSTALL_DIR: /opt/ghidra",
      "          JAVA_HOME: !!js caller.java",
      "",
    ].join("\n"),
  );
  const host = createSystemDoctorHost({
    HOME: home,
    JAVA_HOME: "/terminal/java",
  });
  try {
    const inspections = await host.providerInspections?.(["dsh"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: true,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
  } finally {
    await host.close?.();
  }
});

it("probes Kuna when only the unused client PATH is unresolved", async () => {
  const home = await createTestTempDirectory("rea-dsh-doctor-kuna-path-");
  const kuna = join(home, "kuna");
  await writeFile(kuna, "#!/bin/sh\nprintf 'kuna 1.833\\n'\n", { mode: 0o700 });
  await mkdir(join(home, ".dsh"), { recursive: true });
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    [
      "- insert:",
      "    - id: rea-mcp",
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      "        serverName: rea",
      "        transport: stdio",
      "        command: rea",
      "        args: [mcp]",
      "        env:",
      "          PATH: !!js caller.path",
      `          REA_KUNA_COMMAND: ${JSON.stringify(kuna)}`,
      `          REA_KUNA_CACHE_DIR: ${JSON.stringify(join(home, "cache"))}`,
      "",
    ].join("\n"),
  );
  const host = createSystemDoctorHost({ HOME: home });
  try {
    const inspections = await host.providerInspections?.(["dsh"]);
    expect(inspections?.find(({ id }) => id === "kuna")).toMatchObject({
      configured: true,
      available: true,
      providerVersion: "1.833",
    });
  } finally {
    await host.close?.();
  }
});

test.skipIf(process.platform !== "win32")(
  "reports Kuna's Windows limitation when the client PATH is unresolved",
  async () => {
    const home = await createTestTempDirectory("rea-dsh-doctor-kuna-windows-");
    await mkdir(join(home, ".dsh"), { recursive: true });
    await writeFile(
      join(home, ".dsh/cordis.patch.yml"),
      [
        "- insert:",
        "    - id: rea-mcp",
        '      name: "@deepseek-ai/dsh-mcp-client"',
        "      config:",
        "        serverName: rea",
        "        transport: stdio",
        "        command: rea",
        "        args: [mcp]",
        "        env:",
        "          PATH: !!js caller.path",
        `          REA_KUNA_COMMAND: ${JSON.stringify(join(home, "kuna.exe"))}`,
        "",
      ].join("\n"),
    );
    const host = createSystemDoctorHost({ HOME: home, USERPROFILE: home });
    try {
      const inspections = await host.providerInspections?.(["dsh"]);
      expect(inspections?.find(({ id }) => id === "kuna")).toMatchObject({
        configured: true,
        available: false,
        checks: [
          expect.objectContaining({
            code: "unsupported_host",
            classification: "unsupported_host",
          }),
        ],
      });
    } finally {
      await host.close?.();
    }
  },
);
