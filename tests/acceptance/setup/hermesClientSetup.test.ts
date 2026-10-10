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
          USERPROFILE: home,
          REA_CLIENT_PROFILE_HOME: home,
          HERMES_HOME: " ${REA_CLIENT_PROFILE_HOME}/profile ",
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

for (const selection of ["default", "custom", "suffix", "explicit"] as const) {
  cliTest(
    `Hermes ${selection} sticky-profile selection preserves the root configuration`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-hermes-sticky-");
      const suffix = selection === "suffix" ? "-dev" : "";
      const native =
        process.platform === "win32"
          ? join(home, "AppData", "Local", `hermes${suffix}`)
          : join(home, `.hermes${suffix}`);
      const root = selection === "custom" ? join(home, "custom root") : native;
      const profile = join(
        root,
        "profiles",
        selection === "explicit" ? "other" : "coder",
      );
      await mkdir(profile, { recursive: true });
      const original =
        "# profile settings\nmodel: custom\nmcp_servers:\n  other:\n    command: other-server\n";
      const config = join(profile, "config.yaml");
      const rootConfig = join(root, "config.yaml");
      await writeFile(config, original);
      await writeFile(rootConfig, "model: root-model\n");
      await writeFile(join(root, "active_profile"), "\uFEFFCoDeR\r\n");
      const run = (args: readonly string[]) =>
        cli.run({
          arguments: args,
          cwd: home,
          environment: {
            USERPROFILE: home,
            LOCALAPPDATA: join(home, "AppData", "Local"),
            HERMES_DATA_DIR_SUFFIX: suffix,
            HERMES_HOME:
              selection === "explicit"
                ? profile
                : selection === "custom"
                  ? root
                  : undefined,
          },
          timeoutMs: 20_000,
        });
      const plan = await run([
        "setup",
        "--client",
        "hermes",
        "--dry-run",
        "--json",
      ]);
      expect(plan.exitCode).toBe(0);
      expect(plan.json).toMatchObject({
        status: "planned",
        plannedActions: expect.arrayContaining([
          expect.objectContaining({ target: config }),
          expect.objectContaining({
            target: join(profile, "skills", "reverse-engineer-anything"),
          }),
        ]),
      });
      expect(
        (await run(["setup", "--client", "hermes", "--yes", "--json"]))
          .exitCode,
      ).toBe(0);
      expect(parse(await readFile(config, "utf8"))).toMatchObject({
        mcp_servers: {
          rea: { enabled: true },
          other: { command: "other-server" },
        },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
      const skill = join(
        profile,
        "skills",
        "reverse-engineer-anything",
        "SKILL.md",
      );
      expect(await readFile(skill, "utf8")).toContain(
        "name: reverse-engineer-anything",
      );
      if (selection === "custom") {
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
          identity: {
            skill: { state: "aligned" },
            registrations: expect.arrayContaining([
              expect.objectContaining({
                client: "hermes",
                config_path: config,
                state: "aligned",
              }),
            ]),
          },
        });
        expect(
          (await run(["setup", "--client", "hermes", "--yes", "--json"])).json,
        ).toMatchObject({ appliedActions: [] });
        expect((await run(["uninstall", "--json"])).exitCode).toBe(0);
        expect(parse(await readFile(config, "utf8"))).toEqual(parse(original));
        await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(rootConfig, "utf8")).toBe("model: root-model\n");
      await expect(access(`${rootConfig}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(root, "skills", "reverse-engineer-anything")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}
for (const name of ["missing", "deleted", "ghost", "../escape", "root"]) {
  cliTest(
    `Hermes rejects unusable sticky profile ${name} without writing a fallback home`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-hermes-invalid-profile-");
      const root = join(home, "hermes root");
      await mkdir(root);
      await writeFile(join(root, "active_profile"), name);
      if (name === "deleted" || name === "ghost") {
        await mkdir(join(root, "profiles", name), { recursive: true });
        if (name === "deleted") {
          await writeFile(
            join(root, "profiles", name, "config.yaml"),
            "model: custom\n",
          );
          await mkdir(join(root, "profiles", ".deleted"));
          await writeFile(
            join(root, "profiles", ".deleted", name),
            "deleted\n",
          );
        }
      }
      const run = (args: readonly string[]) =>
        cli.run({
          arguments: args,
          cwd: home,
          environment: { USERPROFILE: home, HERMES_HOME: root },
          timeoutMs: 20_000,
        });
      const rejected = await run([
        "setup",
        "--client",
        "hermes",
        "--yes",
        "--json",
      ]);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
        remediation: expect.stringContaining("Hermes profile"),
      });
      await expect(access(join(root, "config.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(join(root, "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (name !== "missing") return;
      const doctor = await run(["doctor", "--client", "hermes", "--json"]);
      expect(doctor.exitCode).not.toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: "hermes",
              state: "invalid",
              remediation: expect.stringContaining("Hermes profile"),
            }),
          ]),
        },
      });
      const unrelated = await run([
        "setup",
        "--client",
        "codex",
        "--yes",
        "--json",
      ]);
      expect(unrelated.exitCode).toBe(0);
    },
  );
}
