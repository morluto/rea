import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Pi public CLI plans, requires approval, applies, diagnoses, repeats, and uninstalls only owned content",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-pi-cli-");
    const agent = join(home, "custom-agent");
    const config = join(agent, "mcp.json");
    const skill = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const original =
      '{ "mcpServers": { "other": { "command": "other-server" } }, "autoEnableCodemode": false }\n';
    await mkdir(agent);
    await writeFile(config, original);
    const cliPath = resolve("scripts/rea.mjs");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: "custom-agent",
          OMP_PROFILE: "work",
          PI_PROFILE: "legacy",
          PI_CONFIG_DIR: ".omp-other",
        },
        timeoutMs: 20_000,
      });

    const planned = await run([
      "setup",
      "--client",
      "pi",
      "--dry-run",
      "--json",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: [
        {
          id: "configure_client:pi",
          label: "Pi",
          target: join("custom-agent", "mcp.json"),
          operation: "update",
        },
        { id: "install_skill" },
      ],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });

    const unapproved = await run(["setup", "--client", "pi", "--json"]);
    expect(unapproved.json).toMatchObject({
      status: "needs_confirmation",
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(original);

    const applied = await run(["setup", "--client", "pi", "--yes", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      clients: { pi: { status: "configured" } },
      appliedActions: ["configured_pi", "installed_skill"],
    });
    const configured = await readFile(config, "utf8");
    expect(JSON.parse(configured)).toMatchObject({
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          type: "stdio",
          command: process.platform === "win32" ? process.execPath : cliPath,
          args: process.platform === "win32" ? [cliPath, "mcp"] : ["mcp"],
        },
      },
      autoEnableCodemode: false,
    });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(skill, "utf8")).toContain(
      "reverse-engineer-anything",
    );

    const doctor = await run(["doctor", "--client", "pi", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: { registrations: [{ client: "pi", state: "aligned" }] },
    });

    const repeat = await run(["setup", "--client", "pi", "--yes", "--json"]);
    expect(repeat.exitCode).toBe(0);
    expect(repeat.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);

    // Uninstall is global; there is no --client or --yes on this CLI surface.
    const help = await run(["uninstall", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--purge-data");
    const removed = await run(["uninstall", "--json"]);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(
      JSON.parse(original),
    );
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

cliTest(
  "malformed Pi overrides do not block selected Codex setup or doctor and never fall back for Pi",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-pi-invalid-cli-");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: "file:///agent%2fdir",
        },
        timeoutMs: 20_000,
      });
    const plan = await run([
      "setup",
      "--client",
      "codex",
      "--dry-run",
      "--json",
    ]);
    expect(plan.exitCode).toBe(0);
    expect(plan.json).toMatchObject({ status: "planned", appliedActions: [] });
    expect(await readdir(home)).toEqual([]);

    const rejected = await run(["setup", "--client", "pi", "--yes", "--json"]);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("PI_CODING_AGENT_DIR"),
    });
    expect(await readdir(home)).toEqual([]);

    const applied = await run([
      "setup",
      "--client",
      "codex",
      "--yes",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      clients: { codex: { status: "configured" } },
    });
    const doctor = await run(["doctor", "--client", "codex", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: {
        registrations: [
          { client: "codex", state: "aligned" },
          {
            client: "pi",
            state: "invalid",
            remediation: expect.stringContaining("PI_CODING_AGENT_DIR"),
          },
        ],
      },
    });
    const piDoctor = await run(["doctor", "--client", "pi", "--json"]);
    expect(piDoctor.exitCode).not.toBe(0);
    expect(piDoctor.json).toMatchObject({ healthy: false });
    expect((await readdir(home)).sort()).toEqual([".agents", ".codex"]);
  },
);
