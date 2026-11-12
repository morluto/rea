import { readFile } from "node:fs/promises";

import { GenericJson } from "release-please/build/src/updaters/generic-json.js";
import { Version } from "release-please/build/src/version.js";
import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";
import { MCP_STARTUP_POLICY } from "../../src/mcpStartupPolicy.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

// Each file lists a fragment of every example Release Please must keep
// current, so a lost marker is caught as well as a stale version.
const versionedDocumentation = [
  {
    path: "docs/getting-started/installation.md",
    examples: ["doctor --provider ghidra --json", '"command": "npx"'],
  },
] as const;
const pluginManifests = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;
const pluginServerConfig = ".codex-plugin/mcp.json";
const cursorPluginManifest = ".cursor-plugin/plugin.json";
const cursorPluginServer = "mcp.json";
const publishedLauncherArgs = (rootPlaceholder: string, version: string) => [
  `${rootPlaceholder}/scripts/plugin-published-mcp-launcher.mjs`,
  version,
];
const releaseExtraFiles = [
  ...versionedDocumentation.map(({ path }) => ({
    type: "generic",
    path,
  })),
  {
    type: "generic",
    path: "src/generatedPackageMetadata.ts",
  },
  {
    type: "json",
    path: "server.json",
    jsonpath: "$.version",
  },
  {
    type: "json",
    path: "server.json",
    jsonpath: "$.packages[0].version",
  },
  ...pluginManifests.flatMap((path) => [
    {
      type: "json",
      path,
      jsonpath: "$.version",
    },
    ...(path.startsWith(".claude")
      ? [
          {
            type: "json",
            path,
            jsonpath: "$.mcpServers.rea.args[1]",
          },
        ]
      : []),
  ]),
  {
    type: "json",
    path: pluginServerConfig,
    jsonpath: "$.mcpServers.rea.args[1]",
  },
  {
    type: "json",
    path: cursorPluginManifest,
    jsonpath: "$.version",
  },
  {
    type: "json",
    path: cursorPluginServer,
    jsonpath: "$.mcpServers.rea.args[1]",
  },
  {
    type: "json",
    path: ".claude-plugin/marketplace.json",
    jsonpath: "$.plugins[0].version",
  },
  {
    type: "json",
    path: ".claude-plugin/marketplace.json",
    jsonpath: "$.plugins[0].mcpServers.rea.args[1]",
  },
];

describe("release configuration", () => {
  it("keeps doctor and setup runtime support aligned with package engines", async () => {
    expect(await readJson("package.json")).toMatchObject({
      engines: { node: SUPPORTED_NODE_VERSION_RANGE },
    });
  });

  it("updates every package-version artifact in release PRs", async () => {
    const configuration = await readJson("release-please-config.json");

    expect(configuration).toMatchObject({
      versioning: "always-bump-minor",
      packages: { ".": { "extra-files": releaseExtraFiles } },
    });
  });

  it.each(versionedDocumentation)(
    "marks every versioned package example in $path",
    async ({ path, examples }) => {
      const content = await readFile(path, "utf8");
      const packageJson = (await readJson("package.json")) as {
        version: string;
      };
      const versionBlocks = [
        ...content.matchAll(
          /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/gu,
        ),
      ].map(([block]) => block);

      for (const example of examples)
        expect(
          versionBlocks.filter((block) => block.includes(example)),
          example,
        ).toHaveLength(1);
      for (const block of versionBlocks)
        expect(new Set(block.match(/rea-agents@[^\s"`]+/gu))).toEqual(
          new Set([`rea-agents@${packageJson.version}`]),
        );
    },
  );

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
  it("distributes both plugins with skills that exist in the package and local marketplace checkouts", async () => {
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
    expect(await readJson(".claude-plugin/plugin.json")).toMatchObject({
      skills: "./skills",
    });
    expect(await readJson(".codex-plugin/plugin.json")).toMatchObject({
      skills: ".cursor-plugin/skills",
    });
    expect(await readJson(".claude-plugin/marketplace.json")).toMatchObject({
      plugins: [
        {
          source: "./",
          strict: false,
          version: pkg.version,
          skills: ["./.cursor-plugin/skills/reverse-engineer-anything"],
          mcpServers: {
            rea: {
              command: "node",
              args: publishedLauncherArgs("${CLAUDE_PLUGIN_ROOT}", pkg.version),
            },
          },
          icon: "./assets/rea-plugin.png",
        },
      ],
    });
    expect(await readJson(".agents/plugins/marketplace.json")).toMatchObject({
      plugins: [
        {
          source: {
            source: "local",
            path: "./",
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

describe("plugin release pins", () => {
  it("advances every plugin pin through Release Please JSON extra-files", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    const currentVersion = Version.parse(packageJson.version);
    const nextVersion = `${currentVersion.major}.${currentVersion.minor + 1}.0`;
    const version = Version.parse(nextVersion);
    const config = (await readJson("release-please-config.json")) as {
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
    const updated = new Map<string, string>();

    for (const extraFile of config.packages["."]["extra-files"]) {
      if (extraFile.type !== "json" || extraFile.jsonpath === undefined)
        continue;
      const content =
        updated.get(extraFile.path) ?? (await readFile(extraFile.path, "utf8"));
      updated.set(
        extraFile.path,
        new GenericJson(extraFile.jsonpath, version).updateContent(content),
      );
    }

    const updatedJson = new Map<string, unknown>(
      [...updated].map(
        ([path, content]) => [path, JSON.parse(content) as unknown] as const,
      ),
    );
    expect(updatedJson.get(".claude-plugin/plugin.json")).toMatchObject({
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
    expect(updatedJson.get(".codex-plugin/plugin.json")).toMatchObject({
      version: nextVersion,
    });
    expect(updatedJson.get(pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          command: "node",
          args: publishedLauncherArgs("${PLUGIN_ROOT}", nextVersion),
          startup_timeout_sec: 30,
        },
      },
    });
    expect(updatedJson.get(cursorPluginManifest)).toMatchObject({
      version: nextVersion,
      skills: ".cursor-plugin/skills",
    });
    expect(updatedJson.get(cursorPluginServer)).toMatchObject({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", `rea-agents@${nextVersion}`, "mcp"],
        },
      },
    });
    expect(updatedJson.get(".claude-plugin/marketplace.json")).toMatchObject({
      plugins: [
        {
          source: "./",
          strict: false,
          version: nextVersion,
          mcpServers: {
            rea: {
              command: "node",
              args: publishedLauncherArgs("${CLAUDE_PLUGIN_ROOT}", nextVersion),
            },
          },
        },
      ],
    });
  });

  it("pins the plugin server launch from the shared MCP declaration", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };

    expect(await readJson(pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          command: "node",
          args: publishedLauncherArgs("${PLUGIN_ROOT}", packageJson.version),
        },
      },
    });
  });

  it.each([
    ...pluginManifests,
    pluginServerConfig,
    cursorPluginManifest,
    cursorPluginServer,
    ".claude-plugin/marketplace.json",
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
