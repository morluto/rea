import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  LIVING_PROSE_ROOTS,
  documentationFactIssues,
  isLivingProsePath,
  literalToolCountIssues,
} from "../../../scripts/lib/docs-facts.mjs";
import type { ProductCatalog } from "../../../scripts/lib/product-catalog.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryRoots: string[] = [];

const README_FACT_FIXTURE_PATHS = [
  "README.md",
  "docs/readme/README_zh.md",
  "docs/readme/README_ja.md",
  "docs/readme/README_ko.md",
  "docs/readme/README_ar.md",
  "website/locales/languages.json",
  "docs/getting-started/installation.md",
  ".agents/skills/reverse-engineer-anything/references/connection-and-recovery.md",
  "AGENTS.md",
  ".github/pull_request_template.md",
] as const;

const README_LINK_DRIFT_MUTATIONS = [
  [
    "(../getting-started/installation.md#supported-agents)",
    "(../getting-started/installation.md#missing-agents)",
  ],
  ["https://rea.tools/zh-CN/guides/", "https://rea.tools/zh-CN/missing/"],
  ["https://rea.tools/zh-CN/guides/", "https://rea.tools/zh-TW/guides/"],
  [
    "https://rea.tools/zh-CN/guides/",
    "https://rea.tools/zh-CN/guides/?other=1",
  ],
  [
    'src="../assets/rea-hopper-analysis.png"',
    'src="../assets/missing-hopper.png"',
  ],
  ['href="https://discord.gg/GkcryMnJDM"', 'href="https://discord.gg/missing"'],
] as const;

const seedReadmeFactFixture = async (directory: string) => {
  for (const path of README_FACT_FIXTURE_PATHS) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, path), destination);
  }
  await mkdir(join(directory, "skills/reverse-engineer-anything"), {
    recursive: true,
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("literal tool counts", () => {
  it("refuses catalog-size restatements in living prose only", async () => {
    const directory = await createTestTempDirectory("rea-tool-count-facts-");
    temporaryRoots.push(directory);
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

  it("invalidates the cached documentation check for every scanned root", async () => {
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
    expect(samples.filter((path) => !cached(path))).toEqual([]);
  });
});

describe("translated README facts", () => {
  it("keeps translated readmes linked to canonical setup and tool details", async () => {
    const directory = await createTestTempDirectory("rea-readme-facts-");
    temporaryRoots.push(directory);
    await seedReadmeFactFixture(directory);
    const translatedPath = join(directory, "docs/readme/README_zh.md");
    const translated = await readFile(translatedPath, "utf8");
    const catalog: ProductCatalog = JSON.parse(
      await readFile(join(root, "docs/public/product-catalog.json"), "utf8"),
    );
    await expect(documentationFactIssues(directory, catalog)).resolves.toEqual(
      [],
    );
    for (const [original, changed] of README_LINK_DRIFT_MUTATIONS) {
      expect(translated).toContain(original);
      await writeFile(
        translatedPath,
        translated.replace(original, changed),
        "utf8",
      );
      await expect(
        documentationFactIssues(directory, catalog),
      ).resolves.toEqual([
        "docs/readme/README_zh.md: documentation links differ from README.md",
      ]);
    }
  });
});
