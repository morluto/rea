import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expect } from "vitest";
import { parseDshCordisDocument } from "../../../src/application/DshCordisPatch.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["codex", "cursor"] as const)(
  "plans, preserves and reverses an explicit catalog selection for %s",
  async (client, { cli }) => {
    const home = await createTestTempDirectory("rea-setup-catalog-");
    const config = join(
      home,
      client === "codex" ? ".codex/config.toml" : ".cursor/mcp.json",
    );
    const original =
      client === "codex"
        ? 'model = "caller-choice"\n[features]\nmcp_tool_list_changed = false\n'
        : JSON.stringify({ caller_choice: true });
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      REA_MCP_TOOL_CATALOG_PROFILE: undefined,
    };
    const setup = (approval: string, profile?: string) =>
      cli.run({
        arguments: [
          "setup",
          "--client",
          client,
          "--no-skill",
          approval,
          "--json",
          ...(profile === undefined ? [] : ["--tool-catalog-profile", profile]),
        ],
        cwd: home,
        environment,
      });
    const parse = (text: string) =>
      client === "codex" ? parseToml(text) : JSON.parse(text);
    const setting =
      client === "codex"
        ? "mcp_servers.rea.env.REA_MCP_TOOL_CATALOG_PROFILE"
        : "mcpServers.rea.env.REA_MCP_TOOL_CATALOG_PROFILE";
    const backup = `${config}.rea.backup`;
    const planned = await setup("--dry-run", "hot-cold");
    expect(planned.exitCode, planned.stderr).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: [
        expect.objectContaining({
          detail: expect.stringContaining(
            "REA_MCP_TOOL_CATALOG_PROFILE=hot-cold",
          ),
        }),
      ],
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(backup)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await setup("--yes", "hot-cold");
    expect(applied.exitCode, applied.stderr).toBe(0);
    const saved = await readFile(config, "utf8");
    expect(parse(saved)).toHaveProperty(setting, "hot-cold");
    expect(parse(saved)).toMatchObject(parse(original));
    expect(await readFile(backup, "utf8")).toBe(original);
    for (const profile of ["hot-cold", undefined]) {
      const repeated = await setup("--yes", profile);
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      expect(repeated.json).toMatchObject({
        status: "ready",
        plannedActions: [],
        appliedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(saved);
    }
    const restored = await setup("--yes", "full");
    expect(restored.exitCode, restored.stderr).toBe(0);
    const full = await readFile(config, "utf8");
    expect(parse(full)).toHaveProperty(setting, "full");
    expect(parse(full)).toMatchObject(parse(original));
    const files = await readdir(dirname(config));
    const invalid = await setup("--yes", "auto");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readFile(config, "utf8")).toBe(full);
    expect(await readdir(dirname(config))).toEqual(files);
  },
);

cliTest.for(["codex", "cursor"] as const)(
  "keeps the full catalog by default for %s without a verified refresh selection",
  async (client, { cli }) => {
    const home = await createTestTempDirectory("rea-setup-default-catalog-");
    const result = await cli.run({
      arguments: ["setup", "--client", client, "--no-skill", "--yes", "--json"],
      cwd: home,
      environment: {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        REA_MCP_TOOL_CATALOG_PROFILE: undefined,
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const path = join(
      home,
      client === "codex" ? ".codex/config.toml" : ".cursor/mcp.json",
    );
    const text = await readFile(path, "utf8");
    const parsed = client === "codex" ? parseToml(text) : JSON.parse(text);
    expect(parsed).not.toHaveProperty(
      client === "codex"
        ? "mcp_servers.rea.env.REA_MCP_TOOL_CATALOG_PROFILE"
        : "mcpServers.rea.env.REA_MCP_TOOL_CATALOG_PROFILE",
    );
  },
);

cliTest(
  "keeps DeepSeek Harness upfront by default and restores it by explicit selection",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-dsh-catalog-");
    const dshHome = join(home, "harness");
    const config = join(dshHome, "cordis.patch.yml");
    const original =
      "- id: agent-default-model\n  config:\n    model: caller-choice\n";
    await mkdir(dshHome);
    await writeFile(config, original);
    const setup = (approval: string, profile?: string) =>
      cli.run({
        arguments: [
          "setup",
          "--client",
          "dsh",
          "--no-skill",
          approval,
          "--json",
          ...(profile === undefined ? [] : ["--tool-catalog-profile", profile]),
        ],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          DSH_HOME: dshHome,
          REA_MCP_TOOL_CATALOG_PROFILE: undefined,
        },
      });
    const read = () => readFile(config, "utf8");
    const setting = "env.REA_MCP_TOOL_CATALOG_PROFILE";

    const upfront = await setup("--yes");
    expect(upfront.exitCode, upfront.stderr).toBe(0);
    const initial = await read();
    const registration = parseDshCordisDocument(initial).servers.rea;
    expect(registration).toMatchObject({ transport: "stdio" });
    expect(registration).not.toHaveProperty(setting);
    expect(initial).toContain(original);

    const preview = await setup("--dry-run", "hot-cold");
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          detail: expect.stringContaining(
            "REA_MCP_TOOL_CATALOG_PROFILE=hot-cold",
          ),
        }),
      ],
    });
    expect(await read()).toBe(initial);

    const optedIn = await setup("--yes", "hot-cold");
    expect(optedIn.exitCode, optedIn.stderr).toBe(0);
    const saved = await read();
    expect(parseDshCordisDocument(saved).servers.rea).toHaveProperty(
      setting,
      "hot-cold",
    );
    const repeated = await setup("--yes");
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.json).toMatchObject({ appliedActions: [] });
    expect(await read()).toBe(saved);

    const restored = await setup("--yes", "full");
    expect(restored.exitCode, restored.stderr).toBe(0);
    const full = await read();
    expect(parseDshCordisDocument(full).servers.rea).toHaveProperty(
      setting,
      "full",
    );
    expect(full).toContain(original);
  },
);
