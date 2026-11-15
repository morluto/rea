import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "./ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import { waitFor } from "../../tests/support/testWait.js";

afterEach(() => vi.unstubAllEnvs());

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
    const supervisor = new ProviderProcessSupervisor({
      ...launch,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
    });
    // Stop only once the descendant exists, so cleanup covers the whole group.
    await waitFor(() =>
      expect(supervisor.snapshot().stdout.text).toContain("descendant"),
    );
    const stopped = await supervisor.stop({
      terminationGraceMs: 100,
      killGraceMs: 500,
    });
    // An unconfirmed cleanup leaves the fixture group alive; stop it here.
    if (stopped.status === "incomplete")
      process.kill(-launch.ownership.processGroupId, "SIGKILL");
    expect(stopped.status).not.toBe("incomplete");
  },
);
