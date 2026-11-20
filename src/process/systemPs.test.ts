import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "./ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import {
  LINUX_SYSTEM_PS_LOCATIONS,
  describeSystemPs,
  resolveSystemPs,
} from "./systemPs.js";
import { waitFor } from "../../tests/support/testWait.js";

afterEach(() => vi.unstubAllEnvs());

const present =
  (...paths: readonly string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path);

it("selects Linux ps from the first fixed system location before REA's PATH", async () => {
  await expect(
    resolveSystemPs("linux", {
      isExecutable: present(...LINUX_SYSTEM_PS_LOCATIONS),
    }),
  ).resolves.toEqual({ command: "/bin/ps", source: "system" });
  await expect(
    resolveSystemPs("linux", { isExecutable: present("/usr/bin/ps") }),
  ).resolves.toEqual({ command: "/usr/bin/ps", source: "system" });
  await expect(
    resolveSystemPs("linux", {
      isExecutable: present("/run/current-system/sw/bin/ps"),
    }),
  ).resolves.toEqual({
    command: "/run/current-system/sw/bin/ps",
    source: "system",
  });
  await expect(
    resolveSystemPs("linux", { isExecutable: present() }),
  ).resolves.toEqual({
    command: "ps",
    source: "path",
  });
});

it("runs /bin/ps on macOS and keeps PATH on other ps platforms", async () => {
  await expect(
    resolveSystemPs("darwin", { isExecutable: present() }),
  ).resolves.toEqual({
    command: "/bin/ps",
    source: "system",
  });
  await expect(
    resolveSystemPs("freebsd", { isExecutable: present("/bin/ps") }),
  ).resolves.toEqual({ command: "ps", source: "path" });
});

it("names which ps ran, and the fixed locations checked before PATH", () => {
  expect(describeSystemPs({ command: "/usr/bin/ps", source: "system" })).toBe(
    "ps at /usr/bin/ps",
  );
  expect(describeSystemPs({ command: "ps", source: "path" })).toBe(
    `ps from REA's PATH (none of ${LINUX_SYSTEM_PS_LOCATIONS.join(", ")} is executable)`,
  );
});

it.runIf(process.platform === "darwin")(
  "confirms owned cleanup on macOS when REA's own PATH cannot find ps",
  async () => {
    // Ownership inspection reads REA's environment; an unusable PATH must not
    // turn a confirmable launch and cleanup into an incomplete one.
    vi.stubEnv("PATH", "/nonexistent-rea-path");
    const launch = await spawnOwnedProviderProcess({
      // A descendant shares the group, so cleanup must inspect the process
      // table to confirm that no member remains.
      command: process.execPath,
      arguments: [
        "-e",
        "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }).once('spawn', () => process.stdout.write('descendant\\n')); setInterval(() => {}, 1000);",
      ],
      runId: `rea-system-ps-${randomUUID()}`,
      cwd: tmpdir(),
      hostEnvironment: process.env,
    });
    let stopped = false;
    // A failed wait or assertion must still release the fixture group.
    onTestFinished(() => {
      if (stopped) return;
      try {
        process.kill(-launch.ownership.processGroupId, "SIGKILL");
      } catch {
        // The group already exited.
      }
    });
    const supervisor = new ProviderProcessSupervisor({
      ...launch,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
    });
    // Stop only once the descendant exists, so cleanup covers the whole group.
    await waitFor(() =>
      expect(supervisor.snapshot().stdout.text).toContain("descendant"),
    );
    const result = await supervisor.stop({
      terminationGraceMs: 100,
      killGraceMs: 500,
    });
    stopped = result.status !== "incomplete";
    expect(result.status).not.toBe("incomplete");
  },
);
