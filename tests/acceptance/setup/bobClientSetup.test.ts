import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Bob dry-run plan discloses REA_MCP_INPUT_SCHEMA_PROFILE=compact default",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-bob-plan-compact-");
    // Create the bob marker dir so the client is detected, but no mcp.json so
    // setup has a configure_client action to plan.
    await mkdir(join(home, ".bob"), { recursive: true });
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
    };

    const planned = await cli.run({
      arguments: [
        "setup",
        "--client",
        "bob",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment,
    });

    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:bob",
          detail: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE=compact"),
        }),
      ],
      appliedActions: [],
    });
  },
);

cliTest(
  "Bob dry-run plan does not override an explicitly set REA_MCP_INPUT_SCHEMA_PROFILE",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-bob-plan-explicit-");
    // Create the bob marker dir so the client is detected.
    await mkdir(join(home, ".bob"), { recursive: true });
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
      // Explicitly set to full via ambient provider env — the plan must
      // show this value and must NOT replace it with compact.
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
    };

    const planned = await cli.run({
      arguments: [
        "setup",
        "--client",
        "bob",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment,
    });

    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:bob",
          detail: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE=full"),
        }),
      ],
    });
    // Must not silently override an explicit setting.
    expect(JSON.stringify(planned.json)).not.toContain(
      "REA_MCP_INPUT_SCHEMA_PROFILE=compact",
    );
  },
);

cliTest(
  "Bob update plan preserves existing REA_MCP_INPUT_SCHEMA_PROFILE=full stored in the registration",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-bob-plan-stored-full-");
    const bobSettings = join(home, ".bob", "settings");
    await mkdir(bobSettings, { recursive: true });
    // Pre-existing registration with full profile and a stale command that
    // will trigger an update action. The plan must show full, not compact.
    await writeFile(
      join(bobSettings, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            type: "stdio",
            command: "npx",
            args: ["-y", "rea-agents@0.0.1", "mcp"],
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
          },
        },
      }),
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
    };

    const planned = await cli.run({
      arguments: [
        "setup",
        "--client",
        "bob",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment,
    });

    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:bob",
          detail: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE=full"),
        }),
      ],
    });
    // Must not claim it will write compact when the stored value is full.
    expect(JSON.stringify(planned.json)).not.toContain(
      "REA_MCP_INPUT_SCHEMA_PROFILE=compact",
    );
  },
);
