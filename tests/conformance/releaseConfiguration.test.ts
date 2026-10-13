import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";
import { MCP_STARTUP_POLICY } from "../../src/mcpStartupPolicy.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

// Each file lists a fragment of every example Release Please must keep
// current, so a lost marker is caught as well as a stale version.
const versionedDocumentation = [
  {
    path: "docs/installation.md",
    examples: [
      "doctor --provider ghidra --json",
      '"command": "npx"',
      "setup --client cursor",
    ],
  },
] as const;
const pluginManifests = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;
const cursorPluginFiles = [
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/mcp.json",
] as const;

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
      packages: {
        ".": {
          "extra-files": [
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
            ...pluginManifests.flatMap((path) =>
              ["$.version", "$.mcpServers.rea.args[1]"].map((jsonpath) => ({
                type: "json",
                path,
                jsonpath,
              })),
            ),
            {
              type: "json",
              path: ".cursor-plugin/plugin.json",
              jsonpath: "$.version",
            },
            {
              type: "json",
              path: ".cursor-plugin/mcp.json",
              jsonpath: "$.mcpServers.rea.args[1]",
            },
          ],
        },
      },
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
        expect(block.match(/rea-agents@[^\s"`]+/gu)).toEqual([
          `rea-agents@${packageJson.version}`,
        ]);
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
  it.each(pluginManifests)(
    "pins the plugin manifest %s and its server launch to the package version",
    async (path) => {
      const packageJson = (await readJson("package.json")) as {
        name: string;
        version: string;
      };

      expect(await readJson(path)).toMatchObject({
        version: packageJson.version,
        mcpServers: {
          rea: {
            command: "node",
            args: [
              path === ".claude-plugin/plugin.json"
                ? "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs"
                : "./scripts/plugin-mcp-launcher.mjs",
              packageJson.version,
            ],
            ...(path === ".codex-plugin/plugin.json" ? { cwd: "." } : {}),
          },
        },
      });
    },
  );

  it("pins the Cursor plugin and the server file its manifest names to the package version", async () => {
    const packageJson = (await readJson("package.json")) as {
      name: string;
      version: string;
    };

    expect(await readJson(".cursor-plugin/plugin.json")).toMatchObject({
      name: "rea",
      version: packageJson.version,
      mcpServers: "./.cursor-plugin/mcp.json",
    });
    expect(await readJson(".cursor-plugin/mcp.json")).toEqual({
      mcpServers: {
        rea: {
          command: "node",
          args: [
            "${CURSOR_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
            packageJson.version,
          ],
        },
      },
    });
  });

  it.each([...pluginManifests, ...cursorPluginFiles])(
    "stores %s in the form Release Please rewrites it to",
    async (path) => {
      // Release Please reserializes JSON extra-files, so any other layout
      // would change formatting in every release PR.
      const content = await readFile(path, "utf8");

      expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}
`);
    },
  );

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
    ])
      expect(manifest.interface[field]).toEqual(expect.stringMatching(/\S/u));
    expect(manifest.interface.capabilities).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)]),
    );
    expect(manifest.interface.defaultPrompt).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)]),
    );
  });

  it("carries the owned Codex startup timeout in the Codex plugin server entry", async () => {
    expect(await readJson(".codex-plugin/plugin.json")).toMatchObject({
      mcpServers: {
        rea: {
          startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
        },
      },
    });
  });
});
