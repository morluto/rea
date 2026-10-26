import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { inspectUnicornProvider } from "./UnicornDoctor.js";
import type { UnicornBridgeLauncher } from "./UnicornBridge.js";
import { UNICORN_PYTHON_ENV_VAR } from "./UnicornRelease.js";

const snapshot = (): ProviderProcessSnapshot => ({
  stdout: { text: "", bytes: 0, observedBytes: 0 },
  stderr: { text: "", bytes: 0, observedBytes: 0 },
  exitCode: 0,
  signal: null,
});

const probeLauncher = (reply: unknown): UnicornBridgeLauncher => {
  return async (spawn) => {
    const requestPath = spawn.arguments[3] as string;
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      reply_path: string;
    };
    await writeFile(request.reply_path, JSON.stringify(reply), {
      flag: "wx",
      mode: 0o600,
    });
    return snapshot();
  };
};

const probeReply = {
  ok: true,
  probe: { engine: { name: "unicorn", version: "2.1.2" } },
};

const makeExecutable = async (): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "rea-unicorn-doctor-"));
  const path = join(dir, "python");
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

const check = (
  inspection: Awaited<ReturnType<typeof inspectUnicornProvider>>,
  name: string,
) => inspection.checks.find((entry) => entry.name === name);

describe("inspectUnicornProvider", () => {
  it("reports unconfigured when the variable is missing", async () => {
    const inspection = await inspectUnicornProvider({}, "linux", "x64");
    expect(inspection.configured).toBe(false);
    expect(inspection.available).toBe(false);
    expect(inspection.providerVersion).toBeNull();
    expect(check(inspection, "configuration")?.ok).toBe(false);
    expect(check(inspection, "configuration")?.classification).toBe(
      "missing_analysis_engine",
    );
  });

  it("reports unsupported_host off Linux x64", async () => {
    const inspection = await inspectUnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      "darwin",
      "arm64",
    );
    expect(inspection.available).toBe(false);
    expect(check(inspection, "host")?.ok).toBe(false);
    expect(check(inspection, "host")?.classification).toBe("unsupported_host");
  });

  it("reports available when the probe succeeds", async () => {
    const python = await makeExecutable();
    try {
      const inspection = await inspectUnicornProvider(
        { [UNICORN_PYTHON_ENV_VAR]: python.path },
        "linux",
        "x64",
        { launcher: probeLauncher(probeReply) },
      );
      expect(inspection.configured).toBe(true);
      expect(inspection.available).toBe(true);
      expect(inspection.providerVersion).toBe("2.1.2");
      expect(check(inspection, "unicorn_importable")?.ok).toBe(true);
      expect(inspection.registrationEnvironment).toEqual({
        [UNICORN_PYTHON_ENV_VAR]: python.path,
      });
    } finally {
      await python.cleanup();
    }
  });

  it("reports unavailable when the probe fails", async () => {
    const python = await makeExecutable();
    try {
      const inspection = await inspectUnicornProvider(
        { [UNICORN_PYTHON_ENV_VAR]: python.path },
        "linux",
        "x64",
        {
          launcher: probeLauncher({
            ok: false,
            reason: "version_mismatch",
            message: "unicorn version 2.0.0 does not match the pinned 2.1.2",
          }),
        },
      );
      expect(inspection.available).toBe(false);
      expect(inspection.providerVersion).toBeNull();
      expect(check(inspection, "unicorn_importable")?.ok).toBe(false);
      expect(check(inspection, "unicorn_importable")?.classification).toBe(
        "runtime_failure",
      );
    } finally {
      await python.cleanup();
    }
  });

  it("reports a nonexistent Python as missing", async () => {
    const inspection = await inspectUnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/nonexistent/python3" },
      "linux",
      "x64",
    );
    expect(inspection.available).toBe(false);
    expect(check(inspection, "python_executable")?.ok).toBe(false);
  });
});
