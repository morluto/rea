import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Antigravity registration does not make Gemini CLI detected",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-antigravity-detection-");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local/state"),
    };
    const run = (args: string[]) =>
      cli.run({
        arguments: ["setup", ...args, "--skill=false", "--json"],
        cwd: home,
        environment,
      });
    const applied = await run(["--client", "antigravity", "--yes"]);
    expect(applied.exitCode, applied.stdout).toBe(0);
    const preview = await run(["--all-detected", "--dry-run"]);
    expect(preview.json).toMatchObject({
      status: "planned",
      plannedActions: [],
    });
    await expect(
      access(join(home, ".gemini/settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The CLI's own marker also shares the parent directory.
    await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
    const cliPreview = await run(["--all-detected", "--dry-run"]);
    expect(cliPreview.json).toMatchObject({
      clientStates: expect.arrayContaining([
        expect.objectContaining({
          client: expect.objectContaining({ name: "antigravity_cli" }),
          detected: true,
        }),
      ]),
    });
    const states = (
      cliPreview.json as {
        clientStates: Array<{ client: { name: string }; detected: boolean }>;
      }
    ).clientStates;
    expect(
      states.find(({ client }) => client.name === "gemini_cli")?.detected,
    ).toBe(false);
    const broadApply = await run(["--all-detected", "--yes"]);
    expect(broadApply.exitCode, broadApply.stdout).toBe(0);
    await expect(
      access(join(home, ".gemini/settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Explicit selection remains available without an automatic marker.
    const explicit = await run(["--client", "gemini_cli", "--dry-run"]);
    expect(explicit.json).toMatchObject({
      plannedActions: expect.arrayContaining([
        expect.objectContaining({ id: "configure_client:gemini_cli" }),
      ]),
    });

    await writeFile(join(home, ".gemini/settings.json"), "{}\n");
    const gemini = await run(["--all-detected", "--dry-run"]);
    expect(gemini.json).toMatchObject({
      plannedActions: expect.arrayContaining([
        expect.objectContaining({ id: "configure_client:gemini_cli" }),
      ]),
    });
  },
);
