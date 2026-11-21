import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "./ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import { describeSystemPs, resolveSystemPs } from "./systemPs.js";
import { waitFor } from "../../tests/support/testWait.js";

afterEach(() => vi.unstubAllEnvs());

const present =
  (...paths: readonly string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path);

const binPs = "/bin/ps";
const usrBinPs = "/usr/bin/ps";
const nixPs = "/run/current-system/sw/bin/ps";

it.each([
  [[binPs, usrBinPs, nixPs], binPs, "system"],
  [[usrBinPs, nixPs], usrBinPs, "system"],
  [[nixPs], nixPs, "system"],
  [[], "ps", "path"],
] as const)("selects Linux ps from %j", async (executable, command, source) => {
  await expect(
    resolveSystemPs("linux", { isExecutable: present(...executable) }),
  ).resolves.toEqual({ command, source });
});

it.each([
  ["darwin", [], binPs, "system"],
  ["freebsd", [], binPs, "system"],
] as const)(
  "selects ps on %s",
  async (platform, executable, command, source) => {
    await expect(
      resolveSystemPs(platform, { isExecutable: present(...executable) }),
    ).resolves.toEqual({ command, source });
  },
);

it("names the executable or the fixed locations tried before PATH", () => {
  expect(describeSystemPs({ command: usrBinPs, source: "system" })).toContain(
    usrBinPs,
  );
  const fallback = describeSystemPs({ command: "ps", source: "path" });
  for (const detail of ["PATH", binPs, usrBinPs, nixPs])
    expect(fallback).toContain(detail);
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
