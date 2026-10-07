import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, rm, writeFile } from "node:fs/promises";
import { expect, onTestFinished } from "vitest";
import { createFirmwareAnalysisProvider } from "../../../src/composition/firmware.js";
import { FirmwareAnalysisService } from "../../../src/application/FirmwareAnalysisService.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../temporaryDirectory.js";

/** Exercise real subprocess ownership with synthetic pinned producer representations. */
export const firmwareFixture = async (mode = "normal") => {
  const root = await createTestTempDirectory("rea-firmware-test-");
  const path = join(root, "input.bin");
  await writeFile(path, Buffer.from("fixture-input-data"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const launches: {
    cwd: string | undefined;
    pid: number | undefined;
    args: readonly string[];
  }[] = [];
  const provider = createFirmwareAnalysisProvider(
    {
      ...process.env,
      REA_BINWALK_COMMAND: "/usr/bin/true",
      REA_UNBLOB_COMMAND: process.execPath,
    },
    async (options) => {
      const start = options.arguments.indexOf("--") + 2;
      const args = options.arguments.slice(start);
      const engine =
        options.arguments[start - 1]?.endsWith("/true") === true
          ? "binwalk"
          : "unblob";
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        expectedCommand: process.execPath,
        arguments: [
          fileURLToPath(new URL("./producer.mjs", import.meta.url)),
          ...args,
        ],
        env: {
          ...options.env,
          REA_FIRMWARE_FIXTURE_MODE: mode,
          REA_FIRMWARE_FIXTURE_ENGINE: engine,
        },
      });
      launches.push({
        cwd: options.cwd,
        pid: spawned.process.pid,
        args: options.arguments,
      });
      if (mode === "cleanup-failure") {
        onTestFinished(async () => {
          if (options.cwd !== undefined)
            await rm(options.cwd, { recursive: true, force: true });
        });
        return {
          ...spawned,
          cleanup: async () => ({
            cleaned: false,
            reason: "injected ownership failure",
          }),
        };
      }
      return spawned;
    },
  );
  return {
    provider,
    service: new FirmwareAnalysisService(provider),
    path,
    output: join(root, "output"),
    root,
    launches,
  };
};

/** Verify only the acquired process groups and private runtime directories. */
export const assertFirmwareCleanup = async (
  launches: Awaited<ReturnType<typeof firmwareFixture>>["launches"],
): Promise<void> => {
  for (const launch of launches) {
    const pid = launch.pid;
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    if (launch.cwd !== undefined)
      await expect(access(launch.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
};
