import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { ok, err } from "../../../src/domain/result.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  existingMaintenanceScope,
  planIntegrationMaintenance,
} from "../../../src/application/UpdateMaintenance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "maintenance plans one refresh for a config-only Antigravity registration without installing skills",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-antigravity-maintenance-");
    const directory = join(home, ".gemini", "config");
    await mkdir(directory, { recursive: true });
    const config = join(directory, "mcp_config.json");
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: "npx", args: ["-y", "rea-agents@0.1.0", "mcp"] },
        notes: { command: "notes-server" },
      },
    });
    await writeFile(config, original);
    const entry = resolve("scripts/rea.mjs");
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      ...(process.env.REA_DARWIN_SWIFTC_PATH === undefined
        ? {}
        : { REA_DARWIN_SWIFTC_PATH: process.env.REA_DARWIN_SWIFTC_PATH }),
      ...(process.env.SDKROOT === undefined
        ? {}
        : { SDKROOT: process.env.SDKROOT }),
    };
    const detected = await detectClients(home, process.platform, environment);
    expect(detected.map(({ name }) => name)).not.toContain("antigravity");
    expect(detected.map(({ name }) => name)).not.toContain("antigravity_cli");
    expect(
      await existingMaintenanceScope(home, entry, environment),
    ).toMatchObject({
      clients: ["antigravity", "antigravity_cli"],
      skill: false,
      skillDestinations: [],
    });
    const plan = await planIntegrationMaintenance(
      home,
      entry,
      environment,
      async (command) => {
        const result = await cli.run({
          arguments: command.slice(2),
          cwd: home,
          environment,
          timeoutMs: 60_000,
        });
        return result.exitCode === 0
          ? ok(result.stdout)
          : err(result.stdout + result.stderr);
      },
    );
    expect(plan).toMatchObject({
      status: "planned",
      scope: { skill: false },
      plannedActions: [
        expect.objectContaining({ kind: "configure_client", target: config }),
      ],
    });
    if (plan.status !== "planned") throw new Error(JSON.stringify(plan));
    expect(plan.command).toContain("--skill=false");
    expect(await readFile(config, "utf8")).toBe(original);
    for (const path of [
      join(directory, "skills"),
      join(home, ".gemini", "antigravity-cli"),
    ])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
  120_000,
);
