import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  LIVING_PROSE_ROOTS,
  readmeFactIssues,
  isLivingProsePath,
  literalToolCountIssues,
} from "../../../scripts/lib/docs-facts.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("literal tool counts", () => {
  it("refuses catalog-size restatements in living prose only", async () => {
    const directory = await createTestTempDirectory("rea-tool-count-facts-");
    const write = async (path: string, content: string) => {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    };
    await write("README.md", "REA exposes 255 tools.\n");
    await write(
      "docs/guides/a.md",
      "One line.\nThe client saw all 1,024 MCP tools.\nIt registered 0 tools.\n",
    );
    await write("website/public/index.html", "<p>240 public tools</p>");
    await write("docs/guides/rea.md", "The client saw 207 REA tools.\n");
    await write(
      "docs/.vitepress/dist/verification/run.html",
      "<p>234 tools</p>",
    );
    await write("docs/verification/run.md", "The catalog had 240 tools.\n");
    await write("docs/releases/1.0.md", "Adds 12 tools.\n");
    await write("docs/guides/b.md", "Six initial tools, then 34 loaded.\n");
    await expect(literalToolCountIssues(directory)).resolves.toEqual([
      'README.md:1: literal tool count "255 tools"; link the generated catalog instead',
      'docs/guides/a.md:2: literal tool count "1,024 MCP tools"; link the generated catalog instead',
      'docs/guides/rea.md:1: literal tool count "207 REA tools"; link the generated catalog instead',
      'website/public/index.html:1: literal tool count "240 public tools"; link the generated catalog instead',
    ]);
  });

  it("invalidates the cached documentation check for prose and directly inspected files", async () => {
    const turbo = JSON.parse(
      await readFile(join(root, "turbo.json"), "utf8"),
    ) as {
      tasks: Record<string, { inputs: readonly (string | object)[] }>;
    };
    const globs = turbo.tasks["docs:check:built"]!.inputs.filter(
      (input): input is string => typeof input === "string",
    );
    const cached = (path: string) =>
      globs.some((glob) => !glob.startsWith("!") && matchesGlob(path, glob)) &&
      !globs.some(
        (glob) => glob.startsWith("!") && matchesGlob(path, glob.slice(1)),
      );
    const samples = LIVING_PROSE_ROOTS.flatMap((start) =>
      isLivingProsePath(start)
        ? [start]
        : [`${start}/nested/page.md`, `${start}/nested/page.html`],
    );
    expect(samples.every(isLivingProsePath)).toBe(true);
    const directlyInspected = [
      ".cursor-plugin/skills/reverse-engineer-anything/SKILL.md",
      ".github/pull_request_template.md",
      "website/locales/languages.json",
    ];
    expect(
      [...samples, ...directlyInspected].filter((path) => !cached(path)),
    ).toEqual([]);
  });
});

describe("translated README facts", () => {
  it("keeps translated readmes linked to canonical setup and tool details", async () => {
    const directory = await createTestTempDirectory("rea-readme-facts-");
    const translatedPath = join(directory, "docs/readme/README_zh.md");
    const links = [
      "[Agents](docs/getting-started/installation.md#supported-agents)",
      "[MCP](docs/getting-started/installation.md#mcp-registry)",
      "[Tools](docs/reference/mcp-contracts.md#generated-catalog)",
      "[Guide](https://rea.tools/guides/)",
      '<img src="docs/figure.svg">',
      '<a href="https://example.org/community">Community</a>',
    ].join("\n");
    const translated = links
      .replaceAll("docs/", "../")
      .replace("rea.tools/guides/", "rea.tools/zh-CN/guides/");
    await mkdir(dirname(translatedPath), { recursive: true });
    await mkdir(join(directory, "website/locales"), { recursive: true });
    await writeFile(join(directory, "README.md"), links);
    await writeFile(translatedPath, translated);
    await writeFile(
      join(directory, "website/locales/languages.json"),
      JSON.stringify([{ code: "zh-CN", readme: "docs/readme/README_zh.md" }]),
    );
    await expect(readmeFactIssues(directory)).resolves.toEqual([]);
    for (const [original, changed] of [
      ["#supported-agents", "#missing-agents"],
      ["/zh-CN/guides/", "/zh-CN/missing/"],
      ["/zh-CN/guides/", "/zh-TW/guides/"],
      ["/zh-CN/guides/", "/zh-CN/guides/?other=1"],
      ["figure.svg", "missing.svg"],
      ["example.org/community", "example.org/missing"],
    ] as const) {
      await writeFile(
        translatedPath,
        translated.replace(original, changed),
        "utf8",
      );
      await expect(readmeFactIssues(directory)).resolves.toEqual([
        "docs/readme/README_zh.md: documentation links differ from README.md",
      ]);
    }
  });
});
