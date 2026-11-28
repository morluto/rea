import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sharedSkill = ".agents/skills/reverse-engineer-anything/SKILL.md";

cliTest.for([true, false])(
  "automatic setup excludes detected manual hosted connectors (skill: %s)",
  async (skill, { cli }) => {
    const home = await createTestTempDirectory("rea-automatic-clients-");
    const marker = join(home, ".grokbot");
    const skillPath = join(home, sharedSkill);
    const arguments_ = ["setup", "--all-detected", "--yes", "--json"];
    await mkdir(marker);
    const run = () =>
      cli.run({
        arguments: skill ? arguments_ : [...arguments_, "--skill=false"],
        cwd: home,
        environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
      });
    const first = await run();
    expect(first.exitCode, first.stdout).toBe(0);
    expect(first.json).toMatchObject({
      status: "ready",
      plannedActions: skill ? [{ id: "install_skill" }] : [],
      appliedActions: skill ? ["installed_skill"] : [],
      doctor: { healthy: true, scope: { clients: [], skill } },
      clientStates: expect.arrayContaining([
        expect.objectContaining({
          client: expect.objectContaining({ name: "grok_bot" }),
          detected: true,
        }),
      ]),
    });
    expect(first.json).toHaveProperty("clients", {});
    if (skill) {
      const installed = await readFile(skillPath, "utf8");
      expect(installed).toContain("name: reverse-engineer-anything");
      const repeated = await run();
      expect(repeated.exitCode, repeated.stdout).toBe(0);
      expect(repeated.json).toMatchObject({
        status: "ready",
        plannedActions: [],
        appliedActions: [],
        doctor: { healthy: true, scope: { clients: [], skill } },
      });
      expect(await readFile(skillPath, "utf8")).toBe(installed);
    } else {
      await expect(access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(access(join(marker, "mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "explicit Grok Bot selection retains manual instructions with all detected clients",
  async ({ cli }) => {
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
        "--all-detected",
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
