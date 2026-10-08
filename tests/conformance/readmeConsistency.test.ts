import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const readmeLanguages = [
  { path: "README.md", label: "English" },
  { path: "README_zh.md", label: "简体中文" },
  { path: "README_zh-TW.md", label: "繁體中文" },
  { path: "README_ja.md", label: "日本語" },
  { path: "README_ko.md", label: "한국어" },
  { path: "README_tr.md", label: "Türkçe" },
  { path: "README_ru.md", label: "Русский" },
  { path: "README_vi.md", label: "Tiếng Việt" },
  { path: "README_th.md", label: "ไทย" },
  { path: "README_de.md", label: "Deutsch" },
  { path: "README_es.md", label: "Español" },
  { path: "README_uk.md", label: "Українська" },
  { path: "README_pl.md", label: "Polski" },
  { path: "README_pt-BR.md", label: "Português (Brasil)" },
  { path: "README_ar.md", label: "العربية" },
  { path: "README_fa.md", label: "فارسی" },
] as const;

const translatedReadmes = readmeLanguages
  .map((language) => language.path)
  .filter((path) => path !== "README.md");

const normalizedProse = (content: string): string =>
  content.replace(/\s+/gu, " ").trim();

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

const shellExamples = (content: string): string[] =>
  [...content.matchAll(/```bash\s*([\s\S]*?)```/gu)].map((match) =>
    (match[1] ?? "").trim(),
  );

const linkedTargets = (content: string): string[] =>
  [...content.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1] ?? "")
    .filter(
      (target) =>
        !target.startsWith("#") &&
        !/^README(?:_[A-Za-z0-9-]+)?\.md$/u.test(target),
    )
    .sort();

describe("onboarding documentation product facts", () => {
  it.each(readmeLanguages)(
    "links every available language from $path",
    async ({ path, label }) => {
      const content = await readFile(resolve(path), "utf8");
      const selector = content.split("\n\n")[1] ?? "";
      expect(selector).toContain(`**${label}**`);
      for (const language of readmeLanguages) {
        if (language.path !== path)
          expect(selector).toContain(`[${language.label}](${language.path})`);
      }
    },
  );

  it("keeps detailed requirements and versioned MCP configuration aligned in the installation guide", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          }),
        }),
      }),
    );
    expect(content).toContain("Node.js 22");
    expect(content).toContain("macOS 12");
    expect(content).toContain("Ubuntu 24.04");
    expect(content).toContain("Fedora 41");
    expect(content).toContain("Arch Linux");
    expect(content).toContain("CachyOS");
    for (const client of SUPPORTED_CLIENT_DEFINITIONS)
      expect(content).toContain(client.displayName);
  });

  it.each(translatedReadmes)(
    "keeps onboarding commands, linked guidance and structure aligned with English in %s",
    async (path) => {
      const [english, translated] = await Promise.all([
        readFile(resolve("README.md"), "utf8"),
        readFile(resolve(path), "utf8"),
      ]);
      expect(shellExamples(translated)).toEqual(shellExamples(english));
      expect(linkedTargets(translated)).toEqual(linkedTargets(english));
      const headingLevels = (content: string): number[] =>
        [...content.matchAll(/^(#{1,6})\s/gmu)].map(
          (match) => match[1]?.length ?? 0,
        );
      expect(headingLevels(translated)).toEqual(headingLevels(english));
      expect(translated.match(/<summary>/gu)?.length).toBe(
        english.match(/<summary>/gu)?.length,
      );
      expect(translated).toContain("Node.js 22.x");
      expect(translated).toContain(">=22.19");
      expect(translated).toContain("24.x");
      expect(translated).toContain(">=24.11");
      expect(translated).toContain("26+");
      expect(translated).toContain("MCP-tool_catalog");
    },
  );

  it("keeps both English CLI onboarding paths discoverable", async () => {
    const content = await readFile(resolve("README.md"), "utf8");
    expect(content).toMatch(
      /\bnpx(?:\s+(?:--yes|-y))?\s+rea-agents(?:@[^\s]+)?\s+setup\b/u,
    );
    expect(content).toMatch(
      /\bnpm\s+install\s+(?:--global|-g)\s+rea-agents\b/u,
    );
    expect(content).toContain("rea setup");
  });

  it("links to optional installer and unattended setup instructions", async () => {
    const [readme, installation] = await Promise.all([
      readFile(resolve("README.md"), "utf8"),
      readFile(resolve("docs/installation.md"), "utf8"),
    ]);
    expect(readme).toMatch(/\]\(docs\/installation\.md(?:#[^)]+)?\)/u);
    const prose = normalizedProse(installation);
    expect(prose).toContain(
      "curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash",
    );
    expect(prose).toMatch(/\brea setup\b[^\n`]*--install-hopper\b/u);
  });

  it("documents explicit setup freshness and rollback", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    const prose = normalizedProse(content);
    expect(prose).toMatch(
      /\bnpx(?:\s+(?:--yes|-y))?\s+rea-agents@latest\s+setup\b/u,
    );
    expect(prose).toMatch(
      /\bnpm exec (?:--yes|-y) --package=rea-agents@\d+\.\d+\.\d+ -- rea setup\b/u,
    );
  });

  it("documents the published MCP Registry installation path", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(content).toContain("MCP Registry");
    expect(content).toContain("io.github.morluto/rea");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          }),
        }),
      }),
    );
  });
});
