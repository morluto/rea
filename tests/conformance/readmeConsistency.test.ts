import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { processTest } from "../support/process/processFixture.js";

const markdown = new MarkdownIt({ html: true });

const examples = (content: string, languages: readonly string[]): string[] =>
  markdown
    .parse(content, {})
    .flatMap((token) =>
      token.type === "fence" && languages.includes(token.info.trim())
        ? [token.content.trim()]
        : [],
    );

// GitHub's heading anchors: lowercase, drop punctuation, keep letters, marks,
// numbers, connectors and zero-width joiners, and hyphenate spaces.
const headingSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/(?!\u200c|\u200d)[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");

describe("onboarding documentation product facts", () => {
  it("documents manual MCP registration with an absolute runtime and entry script", async () => {
    const content = await readFile(
      resolve("docs/getting-started/installation.md"),
      "utf8",
    );
    expect(
      examples(content, ["json"]).map((value): unknown => JSON.parse(value)),
    ).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "/absolute/path/to/node",
            args: ["/absolute/path/to/rea/scripts/rea.mjs", "mcp"],
          }),
        }),
      }),
    );
  });

  it("keeps translated onboarding commands aligned with the English examples", async () => {
    const inventory = JSON.parse(
      await readFile(resolve("website/locales/languages.json"), "utf8"),
    ) as { code: string; readme: string }[];
    const translatedReadmes = inventory
      .filter((language) => language.code !== "en")
      .map((language) => language.readme);
    const english = examples(await readFile(resolve("README.md"), "utf8"), [
      "bash",
      "sh",
    ]);
    for (const path of translatedReadmes)
      expect(
        examples(await readFile(resolve(path), "utf8"), ["bash", "sh"]),
        path,
      ).toEqual(english);
  });

  it("resolves every in-page README link to a rendered heading", async () => {
    const inventory = JSON.parse(
      await readFile(resolve("website/locales/languages.json"), "utf8"),
    ) as { readme: string }[];
    let checked = 0;
    for (const { readme } of inventory) {
      const tokens = markdown.parse(
        await readFile(resolve(readme), "utf8"),
        {},
      );
      const anchors = new Set<string>();
      const repeats = new Map<string, number>();
      const fragments: string[] = [];
      for (const [index, token] of tokens.entries()) {
        if (token.type === "heading_open") {
          const slug = headingSlug(
            (tokens[index + 1]?.children ?? [])
              .filter(({ type }) => type === "text" || type === "code_inline")
              .map(({ content }) => content)
              .join(""),
          );
          const seen = repeats.get(slug) ?? 0;
          repeats.set(slug, seen + 1);
          anchors.add(seen === 0 ? slug : `${slug}-${String(seen)}`);
        }
        for (const html of [token, ...(token.children ?? [])].filter(
          ({ type }) => type === "html_block" || type === "html_inline",
        ))
          for (const [, id] of html.content.matchAll(
            /\s(?:id|name)="([^"]+)"/gu,
          ))
            anchors.add(id ?? "");
        for (const child of token.children ?? []) {
          const href =
            child.type === "link_open" ? child.attrGet("href") : null;
          if (href?.startsWith("#"))
            fragments.push(decodeURIComponent(href.slice(1)));
        }
      }
      expect(
        fragments.filter((fragment) => !anchors.has(fragment)),
        readme,
      ).toEqual([]);
      checked += fragments.length;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps the zero-width non-joiners that GitHub retains in heading anchors", () => {
    // Confirmed against GitHub's rendered Persian and Malayalam READMEs, which
    // retain U+200C, so dropping it from only the heading or only the link
    // breaks that link.
    expect(headingSlug("REA چگونه کار می\u200cکند")).toBe(
      "rea-چگونه-کار-می\u200cکند",
    );
    expect(headingSlug("Updating REA (CLI)")).toBe("updating-rea-cli");
  });
});

describe("published performance evidence", () => {
  const script = resolve(
    "tests/support/analysis-efficiency/mcp-integer-report.mjs",
  );
  const report = resolve(
    "docs/verification/analysis-efficiency/mcp-integer-allocation.md",
  );
  processTest(
    "keeps generated report facts aligned with committed receipts",
    async ({ processes }) => {
      const result = await processes.run(process.execPath, [script, "--check"]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    },
  );
  for (const section of ["normal", "heap"]) {
    processTest(
      `rejects stale ${section} measurements without rewriting the report`,
      async ({ processes }) => {
        const source = await readFile(report, "utf8");
        const begin = `<!-- BEGIN:allocation-report:${section} -->`;
        const end = `<!-- END:allocation-report:${section} -->`;
        const start = source.indexOf(begin) + begin.length;
        const finish = source.indexOf(end);
        const block = source.slice(start, finish);
        const stale = block.replace(/\d+\.\d{3}/u, (value) =>
          (Number(value) + 1).toFixed(3),
        );
        expect(stale).not.toBe(block);
        const path = resolve(
          await createTestTempDirectory("rea-report-stale-"),
          "report.md",
        );
        const content = source.slice(0, start) + stale + source.slice(finish);
        await writeFile(path, content);
        const result = await processes.run(process.execPath, [
          script,
          "--check",
          "--markdown",
          path,
        ]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(
          `Generated allocation report differs: ${section}`,
        );
        expect(await readFile(path, "utf8")).toBe(content);
      },
    );
  }
  processTest(
    "refuses missing producer markers before writing",
    async ({ processes }) => {
      const source = await readFile(report, "utf8");
      const content = source.replace(
        "<!-- BEGIN:allocation-report:normal -->",
        "",
      );
      expect(content).not.toBe(source);
      const path = resolve(
        await createTestTempDirectory("rea-report-marker-"),
        "report.md",
      );
      await writeFile(path, content);
      const result = await processes.run(process.execPath, [
        script,
        "--markdown",
        path,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "Expected one opening report marker: normal",
      );
      expect(await readFile(path, "utf8")).toBe(content);
    },
  );
});
