import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/**
 * Setup may record a PATH alias of the selected runtime or entry script, so
 * the launcher is compared by resolved file identity rather than spelling.
 */
const assertSelectedLauncher = async (value: unknown) => {
  const [runtime, entrypoint] = z
    .tuple([z.string(), z.string(), z.literal("mcp")])
    .parse(value);
  expect(isAbsolute(runtime)).toBe(true);
  expect(isAbsolute(entrypoint)).toBe(true);
  expect(await realpath(runtime)).toBe(await realpath(process.execPath));
  expect(await realpath(entrypoint)).toBe(
    await realpath(resolve("scripts/rea.mjs")),
  );
};

cliTest(
  "Kiro public CLI plans, requires approval, applies, diagnoses, repeats, and uninstalls only owned content",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-kiro-cli-");
    const settings = join(home, ".kiro", "settings");
    const config = join(settings, "mcp.json");
    const skill = join(
      home,
      ".kiro",
      "skills",
      "reverse-engineer-anything",
      "SKILL.md",
    );
    // A prior REA release entry with caller choices, beside Kiro IDE settings.
    const original = `${JSON.stringify(
      {
        mcpServers: {
          other: { command: "other-server", args: [], disabled: true },
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@6.1.0", "mcp"],
            autoApprove: ["list_documents"],
            timeout: 180000,
          },
        },
        powers: { mcpServers: {} },
      },
      null,
      2,
    )}\n`;
    await mkdir(settings, { recursive: true });
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: { HOME: home, USERPROFILE: home },
        timeoutMs: 20_000,
      });

    const planned = await run([
      "setup",
      "--client",
      "kiro",
      "--dry-run",
      "--json",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: [
        {
          id: "configure_client:kiro",
          label: "Kiro",
          target: config,
          operation: "update",
        },
        {
          id: "install_skill:kiro",
          target: join(home, ".kiro", "skills", "reverse-engineer-anything"),
        },
      ],
      appliedActions: [],
    });

    const unapproved = await run(["setup", "--client", "kiro", "--json"]);
    expect(unapproved.json).toMatchObject({
      status: "needs_confirmation",
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(original);

    const applied = await run(["setup", "--client", "kiro", "--yes", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      clients: { kiro: { status: "configured" } },
    });
    const configured = await readFile(config, "utf8");
    expect(JSON.parse(configured)).toEqual({
      mcpServers: {
        other: { command: "other-server", args: [], disabled: true },
        rea: {
          command: expect.any(String),
          args: [expect.any(String), "mcp"],
          disabled: false,
          autoApprove: ["list_documents"],
          timeout: 180000,
        },
      },
      powers: { mcpServers: {} },
    });
    const launcher = z
      .object({
        mcpServers: z.object({
          rea: z.object({ command: z.string(), args: z.array(z.string()) }),
        }),
      })
      .parse(JSON.parse(configured)).mcpServers.rea;
    await assertSelectedLauncher([launcher.command, ...launcher.args]);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(skill, "utf8")).toContain(
      "reverse-engineer-anything",
    );

    const doctor = await run(["doctor", "--client", "kiro", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "kiro", state: "aligned" }),
        ]),
      },
    });

    const repeat = await run(["setup", "--client", "kiro", "--yes", "--json"]);
    expect(repeat.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);

    const removed = await run(["uninstall", "--json"]);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: {
        other: { command: "other-server", args: [], disabled: true },
      },
      powers: { mcpServers: {} },
    });
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
