import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Hermes setup, doctor and uninstall use the expanded profile and its personal skill",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-hermes-cli-");
    const profile = join(home, "profile");
    const config = join(profile, "config.yaml");
    const skill = join(profile, "skills/reverse-engineer-anything/SKILL.md");
    const original =
      "# user settings\nmodel: custom\nmcp_servers:\n  other:\n    command: other-server\n";
    await mkdir(profile);
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          HERMES_HOME: " ${HOME}/profile ",
        },
        timeoutMs: 20_000,
      });
    const planned = await run([
      "setup",
      "--client",
      "hermes",
      "--dry-run",
      "--json",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: expect.arrayContaining([
        expect.objectContaining({ target: config }),
        expect.objectContaining({
          target: join(profile, "skills/reverse-engineer-anything"),
        }),
      ]),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
    const applied = await run([
      "setup",
      "--client",
      "hermes",
      "--yes",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({ status: "ready" });
    expect(parse(await readFile(config, "utf8"))).toMatchObject({
      model: "custom",
      mcp_servers: {
        other: { command: "other-server" },
        rea: { enabled: true },
      },
    });
    expect(await readFile(config + ".rea.backup", "utf8")).toBe(original);
    expect(await readFile(skill, "utf8")).toContain(
      "reverse-engineer-anything",
    );
    await expect(
      access(join(home, ".agents/skills/reverse-engineer-anything/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const doctor = await run([
      "doctor",
      "--client",
      "hermes",
      "--skill",
      "--json",
    ]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: { skill: { state: "aligned" } },
    });
    const repeat = await run([
      "setup",
      "--client",
      "hermes",
      "--yes",
      "--json",
    ]);
    expect(repeat.json).toMatchObject({ status: "ready", appliedActions: [] });
    const uninstall = await run(["uninstall", "--json"]);
    expect(uninstall.exitCode).toBe(0);
    expect(parse(await readFile(config, "utf8"))).toEqual(parse(original));
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
