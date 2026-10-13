import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import {
  createHistoricalSourceManifest,
  parseHistoricalSourceGraph,
} from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform === "win32")(
  "compiled historical-source summaries",
  () => {
    cliTest(
      "selects a committed summary without changing complete output",
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-reference-summary-");
        await mkdir(join(root, "src", "nested"), { recursive: true });
        await Promise.all([
          writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
          writeFile(
            join(root, "src", "main.js"),
            'import "./nested/value.js";\n',
          ),
          writeFile(
            join(root, "src", "nested", "value.js"),
            "export const value = 1;\n",
          ),
          writeFile(join(root, "\uE000.js"), "export const first = 1;\n"),
          writeFile(join(root, "\u{10000}.js"), "export const last = 2;\n"),
        ]);
        const run = (...options: string[]) =>
          cli.run({
            arguments: ["import-reference-source", root, "--json", ...options],
            cwd: root,
          });
        const complete = await run();
        expect(complete.exitCode).toBe(0);
        const graph = parseHistoricalSourceGraph(complete.json);
        expect((await run("--detail", "full")).stdout).toBe(complete.stdout);
        for (const depth of [undefined, 0, 1, 10]) {
          const result = await run(
            "--detail",
            "summary",
            ...(depth === undefined ? [] : ["--outline-depth", String(depth)]),
          );
          expect(result.exitCode).toBe(0);
          const selected = graph.entries.filter(
            (entry) => entry.path.split("/").length <= (depth ?? 2),
          );
          expect(result.json).toMatchObject({
            schema: "HistoricalSourceSummary",
            authority: graph.authority,
            root_alias: graph.root_alias,
            manifest: createHistoricalSourceManifest(graph),
            inventory_state: graph.inventory_state,
            provenance: graph.provenance,
            vcs: graph.vcs,
            languages: graph.languages,
            manifests: graph.manifests,
            counts: {
              entries: 7,
              files: 5,
              directories: 2,
              symlinks: 0,
              relationships: 1,
              parse_failures: 0,
              exclusions: 0,
            },
            outline: {
              depth: depth ?? 2,
              entries: selected.map(({ path, kind }) =>
                expect.objectContaining({ path, kind }),
              ),
              omitted_entry_count: graph.entries.length - selected.length,
            },
          });
          expect(result.json).not.toHaveProperty("relationships");
        }
      },
    );

    cliTest(
      "retains exclusions and parse coverage independently of a hidden outline",
      async ({ cli }) => {
        const root = await createTestTempDirectory(
          "rea-reference-partial-summary-",
        );
        await Promise.all([
          writeFile(join(root, ".gitignore"), "ignored.txt\n"),
          writeFile(join(root, "ignored.txt"), "ignored\n"),
          writeFile(join(root, "broken.js"), "export const = ;\n"),
        ]);
        const result = await cli.run({
          arguments: [
            "import-reference-source",
            root,
            "--detail",
            "summary",
            "--outline-depth",
            "0",
            "--json",
          ],
          cwd: root,
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({
          inventory_state: "partial",
          counts: { parse_failures: 1, exclusions: 1 },
          exclusions: [
            {
              path: "ignored.txt",
              reason: "project-ignored",
              pattern: "ignored.txt",
            },
          ],
          outline: { depth: 0, entries: [], omitted_entry_count: 2 },
        });
      },
    );
  },
);

describe("compiled historical-source summary input boundaries", () => {
  cliTest(
    "documents detail and depth in public command help",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["import-reference-source", "--help"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--detail");
      expect(result.stdout).toContain("--outline-depth");
      expect(result.stdout).toContain("requires --detail summary");
    },
  );

  for (const options of [
    ["--detail", "summry"],
    ["--detail", "summary", "--outline-depth", "-1"],
    ["--detail", "summary", "--outline-depth", "1.5"],
    ["--detail", "summary", "--outline-depth", "NaN"],
    ["--detail", "summary", "--outline-depth", "9007199254740992"],
    ["--outline-depth", "1"],
    ["--detail", "full", "--outline-depth", "1"],
  ]) {
    cliTest(`rejects ${options.join(" ")}`, async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-reference-summary-input-",
      );
      const result = await cli.run({
        arguments: ["import-reference-source", root, ...options, "--json"],
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("HistoricalSourceGraph");
      expect(result.stdout).not.toContain("HistoricalSourceSummary");
      expect(result.stdout).toMatch(/detail|outline/u);
    });
  }

  cliTest(
    "preserves the missing-root failure in summary mode",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-reference-summary-missing-",
      );
      const result = await cli.run({
        arguments: [
          "import-reference-source",
          join(root, "missing"),
          "--detail",
          "summary",
          "--json",
        ],
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Import failed",
        category: "invalid_input",
        message: expect.stringContaining(
          "Reference source root could not be resolved",
        ),
      });
    },
  );
});
