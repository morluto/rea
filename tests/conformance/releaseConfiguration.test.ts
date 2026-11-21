import { readFile } from "node:fs/promises";

import { Generic } from "release-please/build/src/updaters/generic.js";
import { GenericJson } from "release-please/build/src/updaters/generic-json.js";
import { Version } from "release-please/build/src/version.js";
import { describe, expect, it } from "vitest";

const nextReleaseVersion = (current: string): string => {
  const parsed = Version.parse(current);
  return `${parsed.major}.${parsed.minor + 1}.0`;
};

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";
import { MCP_STARTUP_POLICY } from "../../src/config/mcpStartupPolicy.js";

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
const versionedCursorSkill =
  ".cursor-plugin/skills/reverse-engineer-anything/SKILL.md";
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
  {
    type: "generic",
    path: versionedCursorSkill,
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
      skills: "./.cursor-plugin/skills",
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

type ReleaseExtraFile = {
  type: string;
  path: string;
  jsonpath?: string;
};

const advanceReleaseExtraFiles = async (nextVersion: string) => {
  const version = Version.parse(nextVersion);
  const config = (await readJson("release-please-config.json")) as {
    versioning: string;
    packages: { ".": { "extra-files": ReleaseExtraFile[] } };
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
  return updated;
};

const updatedJsonFrom = (updated: Map<string, string>, path: string) =>
  JSON.parse(updated.get(path) ?? "null") as unknown;

describe("release extra-file advancement", () => {
  it("advances installation examples and generated package metadata", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    const nextVersion = nextReleaseVersion(packageJson.version);
    const updated = await advanceReleaseExtraFiles(nextVersion);
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
    expect(updatedJsonFrom(updated, "server.json")).toMatchObject({
      version: nextVersion,
      packages: [{ identifier: "rea-agents", version: nextVersion }],
    });
  });

  it("advances every plugin pin through Release Please JSON extra-files", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    const nextVersion = nextReleaseVersion(packageJson.version);
    const updated = await advanceReleaseExtraFiles(nextVersion);
    expect(
      updatedJsonFrom(updated, ".claude-plugin/plugin.json"),
    ).toMatchObject({
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
    expect(updatedJsonFrom(updated, ".codex-plugin/plugin.json")).toMatchObject(
      {
        version: nextVersion,
      },
    );
    expect(updatedJsonFrom(updated, pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          command: "node",
          args: publishedLauncherArgs("${PLUGIN_ROOT}", nextVersion),
          startup_timeout_sec: MCP_STARTUP_POLICY.pluginColdStartTimeoutSeconds,
        },
      },
    });
    expect(updatedJsonFrom(updated, cursorPluginManifest)).toMatchObject({
      version: nextVersion,
      skills: ".cursor-plugin/skills",
    });
    expect(updatedJsonFrom(updated, cursorPluginServer)).toMatchObject({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", `rea-agents@${nextVersion}`, "mcp"],
        },
      },
    });
    expect(
      updatedJsonFrom(updated, ".claude-plugin/marketplace.json"),
    ).toMatchObject({
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
    expect(updated.get(versionedCursorSkill)).toContain(
      `rea-agents@${nextVersion}`,
    );
    expect(updated.get(versionedCursorSkill)).not.toContain(
      `rea-agents@${packageJson.version}`,
    );
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

  it("gives the Codex plugin launcher a cold-start budget that covers installing the package", async () => {
    expect(await readJson(pluginServerConfig)).toMatchObject({
      mcpServers: {
        rea: {
          startup_timeout_sec: MCP_STARTUP_POLICY.pluginColdStartTimeoutSeconds,
        },
      },
    });
  });
});

describe("Cursor skill release pin", () => {
  it("advances the committed skill pin through Release Please markers", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    const nextVersion = nextReleaseVersion(packageJson.version);
    const content = await readFile(versionedCursorSkill, "utf8");
    const versionBlocks = [
      ...content.matchAll(
        /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/gu,
      ),
    ].map(([block]) => block);
    expect(versionBlocks).toHaveLength(1);
    expect(versionBlocks[0]).toContain(`rea-agents@${packageJson.version}`);
    expect(content).toMatch(
      new RegExp(
        String.raw`rea-agents@${packageJson.version.replaceAll(".", String.raw`\.`)}[^\n]*x-release-please-version`,
        "u",
      ),
    );
    const updated = new Generic({
      version: Version.parse(nextVersion),
    }).updateContent(content);
    expect(updated).toContain(`rea-agents@${nextVersion}`);
    expect(updated).not.toContain(`rea-agents@${packageJson.version}`);
  });
});
