import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  { marker: true, skill: true },
  { marker: true, skill: false },
  { marker: false, skill: true },
])(
  "automatic setup excludes manual hosted connectors (marker: $marker, skill: $skill)",
  async ({ marker, skill }, { cli }) => {
    const home = await createTestTempDirectory("rea-automatic-clients-");
    if (marker) await mkdir(join(home, ".grokbot"));
    const run = () =>
      cli.run({
        arguments: [
          "setup",
          "--all-detected",
          "--yes",
          "--json",
          ...(skill ? [] : ["--skill=false"]),
        ],
        cwd: home,
        environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
      });
    const first = await run();
    expect(first.exitCode, first.stdout).toBe(0);
    expect(first.json).toMatchObject({
      status: "ready",
      appliedActions: skill ? ["installed_skill"] : [],
      clients: {},
      doctor: { healthy: true, scope: { clients: [], skill } },
    });
    if (marker)
      expect(first.json).toMatchObject({
        clientStates: expect.arrayContaining([
          expect.objectContaining({
            client: expect.objectContaining({ name: "grok_bot" }),
            detected: true,
          }),
        ]),
      });
    const repeated = await run();
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
      doctor: { healthy: true, scope: { clients: [], skill } },
    });
    await expect(
      access(join(home, ".grokbot", "mcp.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest.for([true, false])(
  "explicit Grok Bot setup retains manual instructions (all detected: %s)",
  async (allDetected, { cli }) => {
    const home = await createTestTempDirectory("rea-explicit-manual-client-");
    await mkdir(join(home, ".grokbot"));
    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "grok_bot",
        "--skill=false",
        "--yes",
        "--json",
        ...(allDetected ? ["--all-detected"] : []),
      ],
      cwd: home,
      environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
    });
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("hosted computer"),
      doctor: { scope: { clients: ["grok_bot"] } },
    });
    await expect(
      access(join(home, ".grokbot", "mcp.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
