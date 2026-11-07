import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type CliResult } from "../../support/cli/cliFixture.js";

const expectCliOnlySelection = async (
  run: (arguments_: readonly string[]) => Promise<CliResult>,
  ideSkill: string,
): Promise<void> => {
  for (const selection of [["--all-detected"], []]) {
    const automatic = await run(["setup", ...selection, "--dry-run", "--json"]);
    expect(automatic.exitCode, automatic.stdout + automatic.stderr).toBe(0);
    for (const id of [
      "install_skill:antigravity",
      "configure_client:antigravity",
    ])
      expect(automatic.json).toMatchObject({
        plannedActions: expect.not.arrayContaining([
          expect.objectContaining({ id }),
        ]),
      });
    await expect(access(ideSkill)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const both = await run([
    "setup",
    "--client",
    "antigravity",
    "--client",
    "antigravity_cli",
    "--dry-run",
    "--json",
  ]);
  expect(both.exitCode, both.stderr).toBe(0);
  expect(both.json).toMatchObject({
    plannedActions: expect.not.arrayContaining([
      expect.objectContaining({ kind: "configure_client" }),
    ]),
  });
};

cliTest(
  "Antigravity surfaces share registration without sharing skill ownership",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-antigravity-surfaces-");
    const config = join(home, ".gemini", "config", "mcp_config.json");
    const ideSkill = join(
      home,
      ".gemini",
      "config",
      "skills",
      "reverse-engineer-anything",
    );
    const cliRoot = join(home, ".gemini", "antigravity-cli");
    const cliSkill = join(cliRoot, "skills", "reverse-engineer-anything");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          ...(process.env.REA_DARWIN_SWIFTC_PATH === undefined
            ? {}
            : { REA_DARWIN_SWIFTC_PATH: process.env.REA_DARWIN_SWIFTC_PATH }),
          ...(process.env.SDKROOT === undefined
            ? {}
            : { SDKROOT: process.env.SDKROOT }),
        },
        timeoutMs: 60_000,
      });
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    const unrelated = {
      mcpServers: { notes: { command: "notes-server" } },
      telemetry: false,
    };
    await writeFile(config, JSON.stringify(unrelated));

    // A shared MCP file alone proves neither surface is installed.
    const detected = await run([
      "setup",
      "--all-detected",
      "--dry-run",
      "--json",
    ]);
    expect(detected.exitCode, detected.stdout + detected.stderr).toBe(0);
    for (const id of [
      "configure_client:antigravity_cli",
      "install_skill:antigravity_cli",
    ])
      expect(detected.json).toMatchObject({
        plannedActions: expect.not.arrayContaining([
          expect.objectContaining({ id }),
        ]),
      });
    await expect(access(cliRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(unrelated);

    const sharedPlan = await run([
      "setup",
      "--client",
      "antigravity",
      "--client",
      "antigravity_cli",
      "--dry-run",
      "--json",
    ]);
    expect(sharedPlan.exitCode, sharedPlan.stderr).toBe(0);
    const plan = sharedPlan.json as {
      plannedActions: readonly { kind: string; target: string }[];
    };
    expect(
      plan.plannedActions.filter(({ kind }) => kind === "configure_client"),
    ).toEqual([expect.objectContaining({ target: config })]);

    for (const [client, skill] of [
      ["antigravity_cli", cliSkill],
      ["antigravity", ideSkill],
    ] as const) {
      const setup = await run(["setup", "--client", client, "--yes", "--json"]);
      expect(setup.exitCode, setup.stderr).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toContain(
        "reverse-engineer-anything",
      );
      await writeFile(join(skill, "user-notes.txt"), client);
      if (client === "antigravity_cli")
        await expectCliOnlySelection(run, ideSkill);
      const doctor = await run([
        "doctor",
        "--client",
        client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stderr).toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client,
              config_path: config,
              state: "aligned",
            }),
          ]),
        },
      });
    }
    const configured = await readFile(config, "utf8");
    const repeated = await run([
      "setup",
      "--client",
      "antigravity",
      "--client",
      "antigravity_cli",
      "--yes",
      "--json",
    ]);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);

    const removed = await run(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(unrelated);
    for (const [client, skill] of [
      ["antigravity_cli", cliSkill],
      ["antigravity", ideSkill],
    ] as const) {
      await expect(access(join(skill, "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(skill, "user-notes.txt"), "utf8")).toBe(
        client,
      );
      const doctor = await run([
        "doctor",
        "--client",
        client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stderr).toBe(1);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({ client, state: "missing" }),
          ]),
        },
      });
    }
  },
  180_000,
);

for (const client of ["antigravity", "antigravity_cli"] as const)
  cliTest(
    `explicit ${client} registration works without installing a skill`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-antigravity-no-skill-");
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment: {
            HOME: home,
            USERPROFILE: home,
            ...(process.env.REA_DARWIN_SWIFTC_PATH === undefined
              ? {}
              : { REA_DARWIN_SWIFTC_PATH: process.env.REA_DARWIN_SWIFTC_PATH }),
            ...(process.env.SDKROOT === undefined
              ? {}
              : { SDKROOT: process.env.SDKROOT }),
          },
          timeoutMs: 60_000,
        });
      const setup = await run([
        "setup",
        "--client",
        client,
        "--skill=false",
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode, setup.stdout + setup.stderr).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      const doctor = await run(["doctor", "--client", client, "--json"]);
      expect(doctor.exitCode, doctor.stdout + doctor.stderr).toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({ client, state: "aligned" }),
          ]),
        },
      });
      for (const directory of [
        join(home, ".gemini", "config", "skills"),
        join(home, ".gemini", "antigravity-cli"),
      ])
        await expect(access(directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      const configuration = join(home, ".gemini", "config", "mcp_config.json");
      await writeFile(configuration, "{");
      const invalid = await run(["doctor", "--client", client, "--json"]);
      expect(invalid.exitCode, invalid.stdout + invalid.stderr).toBe(1);
      expect(invalid.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({ client, state: "invalid" }),
          ]),
        },
      });
    },
    120_000,
  );
