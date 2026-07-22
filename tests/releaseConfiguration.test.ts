import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const readmes = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
] as const;

describe("release configuration", () => {
  it("updates every package-version artifact in release PRs", async () => {
    const configuration = await readJson("release-please-config.json");

    expect(configuration).toMatchObject({
      packages: {
        ".": {
          "extra-files": [
            ...readmes.map((path) => ({ type: "generic", path })),
            {
              type: "generic",
              path: "src/generatedPackageMetadata.ts",
            },
            {
              type: "json",
              path: "docs/product-catalog.json",
              jsonpath: "$.package.version",
            },
          ],
        },
      },
    });
  });

  it.each(readmes)(
    "marks the versioned package example in %s",
    async (path) => {
      const content = await readFile(path, "utf8");
      const versionBlock =
        /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/u.exec(
          content,
        )?.[0];

      expect(versionBlock).toMatch(/rea-agents@\d+\.\d+\.\d+/u);
    },
  );

  it("keeps generated metadata compatible with the generic updater", async () => {
    const generator = await readFile(
      "scripts/generate-package-metadata.mjs",
      "utf8",
    );
    const generated = await readFile("src/generatedPackageMetadata.ts", "utf8");

    expect(generator).toContain("x-release-please-version");
    expect(generated).toContain("x-release-please-version");
  });

  it("keeps TypeDoc unversioned and outside the tracked documentation tree", async () => {
    await expect(readJson("typedoc.json")).resolves.toMatchObject({
      includeVersion: false,
      out: "build/api-docs",
    });
  });
});
