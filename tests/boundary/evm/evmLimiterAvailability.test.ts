import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import {
  EVM_PRLIMIT_COMMAND_DEFAULT,
  evmLimiterAvailability,
} from "../../../src/evm/EvmoleInterfaceProvider.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";

const linux = { platform: "linux" as const, arch: "x64" };
const status = { open: false, capabilities: [] };
const basePolicy = { processCaptureEnabled: true, evmInterfaceEnabled: true };

it("probes the default limiter with executable and regular-file checks", async () => {
  const calls: unknown[][] = [];
  const availability = await evmLimiterAvailability(
    {},
    {
      ...linux,
      fs: {
        access: async (path, mode) => {
          calls.push(["access", path, mode]);
        },
        stat: async (path) => {
          calls.push(["stat", path]);
          return { isFile: () => true };
        },
      },
    },
  );

  expect(availability).toMatchObject({
    status: "available",
    diagnostics: { limiter_path: EVM_PRLIMIT_COMMAND_DEFAULT },
  });
  expect(calls).toEqual([
    ["access", EVM_PRLIMIT_COMMAND_DEFAULT, 1],
    ["stat", EVM_PRLIMIT_COMMAND_DEFAULT],
  ]);
});

it.each(["EACCES", "EPERM"])(
  "uses the exact absolute override and reports denied access: %s",
  async (code) => {
    const limiter = "/fixture/util-linux/prlimit";
    const availability = await evmLimiterAvailability(
      { REA_EVM_PRLIMIT_COMMAND: limiter },
      {
        ...linux,
        fs: {
          access: async (path) => {
            expect(path).toBe(limiter);
            throw Object.assign(new Error("permission denied"), {
              code,
            });
          },
          stat: async () => {
            throw new Error("stat must not run after access failure");
          },
        },
      },
    );

    expect(availability).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      reason: expect.stringContaining(limiter),
      diagnostics: { limiter_path: limiter, system_code: code },
    });
    if (availability === undefined) throw new Error("Expected limiter probe");
    const entry = buildCapabilityInventory(status, {
      ...basePolicy,
      evmLimiterAvailability: availability,
    }).find(({ name }) => name === "inspect_evm_interface");
    expect(entry?.remediation).toContain("REA_EVM_PRLIMIT_COMMAND");
    expect(entry?.remediation).toContain("execute permission");
  },
);

it("rejects a relative override and non-file without probing an alternate command", async () => {
  const relative = await evmLimiterAvailability(
    { REA_EVM_PRLIMIT_COMMAND: "prlimit" },
    {
      ...linux,
      fs: {
        access: async () => {
          throw new Error("relative paths must be rejected first");
        },
        stat: async () => ({ isFile: () => true }),
      },
    },
  );
  expect(relative).toMatchObject({
    status: "unavailable",
    code: "not_configured",
    reason: expect.stringContaining("absolute executable regular file"),
    diagnostics: {
      limiter_path: "prlimit",
      code: "prlimit_not_absolute",
      setting: "REA_EVM_PRLIMIT_COMMAND",
    },
  });

  const directory = await evmLimiterAvailability(
    {},
    {
      ...linux,
      fs: {
        access: async () => undefined,
        stat: async () => ({ isFile: () => false }),
      },
    },
  );
  expect(directory).toMatchObject({
    status: "unavailable",
    code: "not_configured",
    reason: expect.stringContaining("absolute executable regular file"),
    diagnostics: expect.objectContaining({ code: "prlimit_not_file" }),
  });
});

it("delivers selected-path recovery from real filesystem probes to capability output", async () => {
  const root = await createTestTempDirectory("rea-evm-limiter-recovery-");
  const executable = join(root, "caller-selected-limiter");
  await writeFile(executable, "not executed by the readiness probe", {
    mode: 0o700,
  });
  for (const [path, expectedCode, expectedReason] of [
    ["prlimit", "not_configured", "absolute executable regular file"],
    [root, "not_configured", "absolute executable regular file"],
    [
      join(root, "missing-limiter"),
      "executable_missing",
      "REA_EVM_PRLIMIT_COMMAND",
    ],
    [executable, null, null],
  ] as const) {
    const availability = await evmLimiterAvailability(
      { REA_EVM_PRLIMIT_COMMAND: path },
      linux,
    );
    expect(availability?.code).toBe(expectedCode);
    expect(availability?.diagnostics.limiter_path).toBe(path);
    if (availability === undefined) throw new Error("Expected limiter probe");
    const entry = buildCapabilityInventory(status, {
      ...basePolicy,
      evmLimiterAvailability: availability,
    }).find(({ name }) => name === "inspect_evm_interface");
    if (expectedReason === null) {
      expect(entry).toMatchObject({ available: true, remediation: null });
    } else {
      expect(entry).toMatchObject({
        available: false,
        reason: "provider_missing",
      });
      expect(entry?.remediation).toContain(expectedReason);
      expect(entry?.remediation).toContain(path);
      expect(entry?.remediation).toContain("util-linux prlimit");
    }
  }
});

it("rechecks on each observation so inventory follows the selected executable's current state", async () => {
  let accessible = true;
  const fs = {
    access: async () => {
      if (!accessible) throw new Error("ENOENT");
    },
    stat: async () => ({ isFile: () => true }),
  };
  const first = await evmLimiterAvailability({}, { ...linux, fs });
  accessible = false;
  const second = await evmLimiterAvailability({}, { ...linux, fs });

  expect(first?.status).toBe("available");
  expect(second).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("ENOENT"),
  });
});

it("yields the event loop while the filesystem owner probe is pending", async () => {
  let release!: () => void;
  const pendingAccess = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accessStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    accessStarted = resolve;
  });
  const probe = evmLimiterAvailability(
    {},
    {
      ...linux,
      fs: {
        access: async () => {
          accessStarted();
          await pendingAccess;
        },
        stat: async () => ({ isFile: () => true }),
      },
    },
  );
  await withVerifierCleanup(async () => {
    await awaitAcknowledgement(started, probe, "filesystem access");
    let timerRan = false;
    setImmediate(() => {
      timerRan = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timerRan).toBe(true);
    release();
    expect(await probe).toMatchObject({ status: "available" });
  }, [
    release,
    async () => {
      await probe;
    },
  ]);
});

it.each(["access", "stat"] as const)(
  "preserves cancellation while the %s filesystem probe is pending",
  async (stage) => {
    let release!: () => void;
    const pendingProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const controller = new AbortController();
    const abortReason = { source: "caller-stop" };
    const probe = evmLimiterAvailability(
      {},
      {
        ...linux,
        signal: controller.signal,
        fs: {
          access: async () => {
            if (stage !== "access") return;
            probeStarted();
            await pendingProbe;
          },
          stat: async () => {
            if (stage === "access")
              throw new Error("stat must not run after access cancellation");
            probeStarted();
            await pendingProbe;
            return { isFile: () => true };
          },
        },
      },
    );

    await withVerifierCleanup(async () => {
      await awaitAcknowledgement(started, probe, `${stage} filesystem probe`);
      controller.abort(abortReason);
      release();
      const error = await probe.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AnalysisCancelledError);
      expect(error).toMatchObject({ operation: "binary_session" });
      expect((error as AnalysisCancelledError).cause).toBe(abortReason);
    }, [
      release,
      async () => {
        await probe.catch(() => undefined);
      },
    ]);
  },
);

it("leaves non-Linux-x64 host gates unchanged", async () => {
  const fs = {
    access: async () => {
      throw new Error("unsupported hosts must not probe prlimit");
    },
    stat: async () => ({ isFile: () => true }),
  };
  expect(
    await evmLimiterAvailability({}, { platform: "darwin", arch: "arm64", fs }),
  ).toBeUndefined();
  expect(
    await evmLimiterAvailability({}, { platform: "linux", arch: "arm64", fs }),
  ).toBeUndefined();
});

it("projects owner prerequisite facts into capability availability", async () => {
  const unavailable = await evmLimiterAvailability(
    {},
    {
      ...linux,
      fs: {
        access: async () => {
          throw new Error("ENOENT");
        },
        stat: async () => ({ isFile: () => true }),
      },
    },
  );
  const unavailableInventory = buildCapabilityInventory(status, {
    ...basePolicy,
    ...(unavailable === undefined
      ? {}
      : { evmLimiterAvailability: unavailable }),
  });
  expect(
    unavailableInventory.find(({ name }) => name === "inspect_evm_interface"),
  ).toMatchObject({
    available: false,
    reason: "provider_missing",
    remediation: expect.stringContaining("caller-supplied util-linux prlimit"),
  });

  const available = await evmLimiterAvailability(
    {},
    {
      ...linux,
      fs: {
        access: async () => undefined,
        stat: async () => ({ isFile: () => true }),
      },
    },
  );
  const availableInventory = buildCapabilityInventory(status, {
    ...basePolicy,
    ...(available === undefined ? {} : { evmLimiterAvailability: available }),
  });
  expect(
    availableInventory.find(({ name }) => name === "inspect_evm_interface"),
  ).toMatchObject({ available: true, reason: "available", remediation: null });
});
