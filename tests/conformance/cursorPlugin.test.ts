import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cursorMarketplaceInstallLinkIssues,
  cursorPluginBundleIssues,
  inspectCursorPluginBundle,
  syncCursorPluginSkill,
} from "../../scripts/lib/cursor-plugin-bundle.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const repositoryRoot = process.cwd();

const authoredSkill = async (
  root: string,
  files: Readonly<Record<string, string>>,
) => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".agents/skills/reverse-engineer-anything", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
};

describe("Cursor Marketplace plugin", () => {
  it("ships the skill and the pinned npm server from the package version", async () => {
    const inspected = await inspectCursorPluginBundle(repositoryRoot);
    expect(inspected.issues).toEqual([]);
    expect(inspected.packageVersion).toBe(inspected.manifest.version);
    expect(inspected.mcp.mcpServers.rea).toEqual({
      command: "npx",
      args: ["-y", `rea-agents@${inspected.packageVersion}`, "mcp"],
    });
  });

  it("keeps the committed skill identical to the authored skill", async () => {
    await expect(
      syncCursorPluginSkill({ root: repositoryRoot, check: true }),
    ).resolves.toBeUndefined();
  });

  it("does not publish an MCP-only Cursor install link", async () => {
    const documents = await Promise.all(
      [
        "README.md",
        "docs/getting-started/installation.md",
        ".cursor-plugin/plugin.json",
        "mcp.json",
      ].map(async (path) => ({
        path,
        text: await readFile(join(repositoryRoot, path), "utf8"),
      })),
    );
    expect(cursorMarketplaceInstallLinkIssues(documents)).toEqual([]);
  });

  it("reports each drifted manifest field without accepting a partial server", () => {
    const aligned = {
      manifest: {
        name: "rea",
        version: "6.8.0",
        description: "Reverse engineer anything",
        author: { name: "morluto" },
        repository: "https://github.com/morluto/rea",
        license: "MIT",
        keywords: ["rea"],
        skills: ".cursor-plugin/skills",
        logo: "assets/rea-plugin.png",
      },
      mcp: {
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@6.8.0", "mcp"],
          },
        },
      },
      packageVersion: "6.8.0",
      logoExists: true,
      skillNames: ["reverse-engineer-anything"],
      skillFrontmatter: {
        name: "reverse-engineer-anything",
        description: "Use REA",
      },
    };
    expect(cursorPluginBundleIssues(aligned)).toEqual([]);
    expect(
      cursorPluginBundleIssues({
        ...aligned,
        manifest: { ...aligned.manifest, name: "other", mcpServers: {} },
        mcp: {
          mcpServers: {
            rea: { command: "node", args: ["dist/mcp/main.js"] },
          },
        },
        logoExists: false,
        skillNames: ["rea-tool-design", "reverse-engineer-anything"],
      }).map(({ field }) => field),
    ).toEqual([
      "name",
      "mcpServers",
      "logo.file",
      "mcp.args",
      "skills.entries",
    ]);
  });

  it("fails closed when the synced skill is missing, edited, or extended", async () => {
    const root = await createTestTempDirectory("rea-cursor-plugin-skill-");
    await authoredSkill(root, {
      "SKILL.md":
        "---\nname: reverse-engineer-anything\ndescription: Use REA\n---\n\n# REA\n",
      "references/guide.md": "# Guide\n",
    });
    await syncCursorPluginSkill({ root, check: false });
    const skill = join(
      root,
      ".cursor-plugin/skills/reverse-engineer-anything/SKILL.md",
    );
    expect(await readFile(skill, "utf8")).toBe(
      "---\nname: reverse-engineer-anything\ndescription: Use REA\n---\n\n# REA\n",
    );
    await expect(
      syncCursorPluginSkill({ root, check: true }),
    ).resolves.toBeUndefined();
    await writeFile(skill, "edited\n");
    await expect(
      syncCursorPluginSkill({ root, check: true }),
    ).rejects.toMatchObject({ code: "cursor_plugin_skill_stale" });
    await syncCursorPluginSkill({ root, check: false });
    await writeFile(
      join(
        root,
        ".cursor-plugin/skills/reverse-engineer-anything/references/extra.md",
      ),
      "extra\n",
    );
    await expect(
      syncCursorPluginSkill({ root, check: true }),
    ).rejects.toMatchObject({ code: "cursor_plugin_skill_inventory" });
  });
});
