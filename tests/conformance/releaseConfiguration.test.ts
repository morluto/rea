import { readFile } from "node:fs/promises";

import { Generic } from "release-please/build/src/updaters/generic.js";
import { GenericJson } from "release-please/build/src/updaters/generic-json.js";
import { Version } from "release-please/build/src/version.js";
import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";
import { MCP_STARTUP_POLICY } from "../../src/config/mcpStartupPolicy.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const pluginManifests = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;
const pluginServerConfig = ".codex-plugin/mcp.json";
const cursorPluginManifest = ".cursor-plugin/plugin.json";
const cursorPluginServer = "mcp.json";

describe("release configuration", () => {
  it("keeps doctor and setup runtime support aligned with package engines", async () => {
    expect(await readJson("package.json")).toMatchObject({
      engines: { node: SUPPORTED_NODE_VERSION_RANGE },
    });
  });

  it("keeps the release baseline, lockfile, and changelog aligned with the package version", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    expect(await readJson(".release-please-manifest.json")).toEqual({
      ".": packageJson.version,
    });
    expect(await readJson("package-lock.json")).toMatchObject({
      version: packageJson.version,
      packages: { "": { version: packageJson.version } },
    });
    const changelog = await readFile("CHANGELOG.md", "utf8");
    expect(/^## \[([^\]]+)\]/mu.exec(changelog)?.[1]).toBe(packageJson.version);
  });

  it("keeps the npm package and MCP Registry metadata aligned", async () => {
    const packageJson = (await readJson("package.json")) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const serverJson = (await readJson("server.json")) as {
      name: string;
      version: string;
      packages: Array<{
        registryType: string;
        registryBaseUrl: string;
        identifier: string;
        version: string;
        runtimeHint: string;
        transport: { type: string };
        packageArguments: Array<{ type: string; value: string }>;
      }>;
    };

    expect(packageJson).toMatchObject({
      name: "rea-agents",
      mcpName: "io.github.morluto/rea",
    });
    expect(serverJson).toMatchObject({
      name: packageJson.mcpName,
      version: packageJson.version,
      packages: [
        {
          registryType: "npm",
          registryBaseUrl: "https://registry.npmjs.org",
          identifier: packageJson.name,
          version: packageJson.version,
          runtimeHint: "npx",
          transport: { type: "stdio" },
          packageArguments: [{ type: "positional", value: "mcp" }],
        },
      ],
    });
  });
});

describe("plugin manifests", () => {
  it("keeps the shared plugin icon and Codex listing metadata aligned", async () => {
    const manifest = (await readJson(".codex-plugin/plugin.json")) as {
      description: string;
      interface: Record<string, unknown>;
    };
    const { logo, composerIcon, ...listing } = manifest.interface;
    expect(String(listing.shortDescription).length).toBeLessThanOrEqual(30);
    expect(listing.websiteURL).toBe("https://rea.tools/");
    expect(logo).toBe("./assets/rea-plugin.png");
    expect(composerIcon).toBe(logo);
    expect(await readJson("package.json")).toMatchObject({
      files: expect.arrayContaining(["assets/rea-plugin.png"]),
    });
    expect(await readJson(".claude-plugin/plugin.json")).toMatchObject({
      icon: logo,
    });
  });

  it("keeps content-rewriting attributes out of Claude's submitted plugin root", async () => {
    const rules = (await readFile(".gitattributes", "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const rule of rules)
      for (const attribute of rule.split(/\s+/u).slice(1))
        expect(attribute).not.toMatch(
          /^[-!]?(?:text|eol|filter|ident|working-tree-encoding|export-ignore|export-subst)(?:=|$)/u,
        );
  });

  it("distributes both plugins with generated canonical skills from the exact npm release", async () => {
    const pkg = (await readJson("package.json")) as {
      version: string;
      files: string[];
    };
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        ...pluginManifests,
        pluginServerConfig,
        cursorPluginManifest,
        ".cursor-plugin/skills",
        cursorPluginServer,
        "skills",
      ]),
    );
    for (const path of pluginManifests)
      expect(await readJson(path)).toMatchObject({ skills: "./skills" });
    for (const path of [
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
    ])
      expect(await readJson(path)).toMatchObject({
        plugins: [
          {
            source: {
              source: "npm",
              package: "rea-agents",
              version: pkg.version,
            },
          },
        ],
      });
  });

  it.each(pluginManifests)(
    "pins the plugin manifest %s and Codex's server config path",
    async (path) => {
      const packageJson = (await readJson("package.json")) as {
        name: string;
        version: string;
      };

      expect(await readJson(path)).toMatchObject({
        version: packageJson.version,
        ...(path.startsWith(".codex")
          ? { mcpServers: `./${pluginServerConfig}` }
          : {}),
      });
    },
  );
});

describe("Cursor Marketplace release pin", () => {
  it("pins the server to the npm release without an inline MCP override", async () => {
    const packageJson = (await readJson("package.json")) as { version: string };
    expect(await readJson(cursorPluginManifest)).toMatchObject({
      version: packageJson.version,
      skills: ".cursor-plugin/skills",
      logo: "assets/rea-plugin.png",
    });
    expect(await readJson(cursorPluginServer)).toEqual({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", `rea-agents@${packageJson.version}`, "mcp"],
        },
      },
    });
    expect(await readJson(cursorPluginManifest)).not.toHaveProperty(
      "mcpServers",
    );
  });
});

it("advances the version exposed in metadata, installation examples, and plugin launches", async () => {
  const packageJson = (await readJson("package.json")) as {
    version: string;
  };
  const currentVersion = Version.parse(packageJson.version);
  const nextVersion = `${currentVersion.major}.${currentVersion.minor + 1}.0`;
  const version = Version.parse(nextVersion);
  const config = (await readJson("release-please-config.json")) as {
    versioning: string;
    packages: {
      ".": {
        "extra-files": Array<{
          type: string;
          path: string;
          jsonpath?: string;
        }>;
      };
    };
  };
  expect(config.versioning).toBe("always-bump-minor");
  const updated = new Map<string, string>();

  for (const extraFile of config.packages["."]["extra-files"]) {
    const updater =
      extraFile.type === "generic"
        ? new Generic({ version })
        : extraFile.type === "json" && extraFile.jsonpath !== undefined
          ? new GenericJson(extraFile.jsonpath, version)
          : undefined;
    if (updater === undefined) continue;
    const content =
      updated.get(extraFile.path) ?? (await readFile(extraFile.path, "utf8"));
    updated.set(extraFile.path, updater.updateContent(content));
  }

  const installation = "docs/getting-started/installation.md";
  const installationBefore = await readFile(installation, "utf8");
  const installationAfter = updated.get(installation) ?? "";
  for (const example of [
    /npx -y rea-agents@(\S+) doctor --provider ghidra --json/gu,
    /"command":\s*"npx",\s*"args":\s*\["-y",\s*"rea-agents@([^"]+)",\s*"mcp"\]/gu,
  ]) {
    expect(
      [...installationBefore.matchAll(example)].map((match) => match[1]),
    ).toEqual([packageJson.version]);
    expect(
      [...installationAfter.matchAll(example)].map((match) => match[1]),
    ).toEqual([nextVersion]);
  }
  for (const [content, pin] of [
    [installationBefore, packageJson.version],
    [installationAfter, nextVersion],
  ] as const) {
    for (const [block] of content.matchAll(
      /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/gu,
    ))
      expect(new Set(block.match(/rea-agents@[^\s"`]+/gu))).toEqual(
        new Set([`rea-agents@${pin}`]),
      );
  }
  expect(updated.get("src/generatedPackageMetadata.ts")).toContain(
    `version: "${nextVersion}"`,
  );
  const updatedJson = (path: string): unknown =>
    JSON.parse(updated.get(path) ?? "null") as unknown;
  expect(updatedJson("server.json")).toMatchObject({
    version: nextVersion,
    packages: [{ identifier: "rea-agents", version: nextVersion }],
  });
  expect(updatedJson(".claude-plugin/plugin.json")).toMatchObject({
    version: nextVersion,
    mcpServers: {
      rea: {
        args: [
          "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
          nextVersion,
        ],
      },
    },
  });
  expect(updatedJson(".codex-plugin/plugin.json")).toMatchObject({
    version: nextVersion,
  });
  expect(updatedJson(pluginServerConfig)).toMatchObject({
    mcpServers: {
      rea: {
        args: ["./scripts/plugin-mcp-launcher.mjs", nextVersion],
      },
    },
  });
  expect(updatedJson(cursorPluginManifest)).toMatchObject({
    version: nextVersion,
    skills: ".cursor-plugin/skills",
  });
  expect(updatedJson(cursorPluginServer)).toMatchObject({
    mcpServers: {
      rea: {
        command: "npx",
        args: ["-y", `rea-agents@${nextVersion}`, "mcp"],
      },
    },
  });
  for (const path of [
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ])
    expect(updatedJson(path)).toMatchObject({
      plugins: [
        {
          source: {
            source: "npm",
            package: "rea-agents",
            version: nextVersion,
          },
        },
      ],
    });
});

describe("plugin release pins", () => {
  it("pins the plugin server launch from the shared MCP declaration", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };

    expect(await readJson(pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          command: "node",
          args: ["./scripts/plugin-mcp-launcher.mjs", packageJson.version],
          cwd: ".",
        },
      },
    });
  });

  it.each([
    ...pluginManifests,
    pluginServerConfig,
    cursorPluginManifest,
    cursorPluginServer,
  ])("stores %s in the form Release Please rewrites it to", async (path) => {
    // Release Please reserializes JSON extra-files, so any other layout
    // would change formatting in every release PR.
    const content = await readFile(path, "utf8");

    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}
`);
  });

  it("declares the interface fields Codex plugin validation requires", async () => {
    const manifest = (await readJson(".codex-plugin/plugin.json")) as {
      interface: Record<string, unknown>;
    };

    for (const field of [
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "composerIcon",
      "logo",
    ])
      expect(manifest.interface[field]).toEqual(expect.stringMatching(/\S/u));
    expect(
      String(manifest.interface.shortDescription).length,
    ).toBeLessThanOrEqual(30);
    expect(manifest.interface.capabilities).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)]),
    );
    expect(manifest.interface.defaultPrompt).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)]),
    );
  });

  it("carries the owned Codex startup timeout in the companion server entry", async () => {
    expect(await readJson(pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
        },
      },
    });
  });
});
