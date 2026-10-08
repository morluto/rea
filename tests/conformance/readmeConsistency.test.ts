import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const setupDocumentation = [
  "docs/installation.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
] as const;

const normalizedProse = (content: string): string =>
  content.replace(/\s+/gu, " ").trim();

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

describe("onboarding documentation product facts", () => {
  it.each(setupDocumentation)(
    "keeps requirements and versioned MCP configuration aligned in %s",
    async (path) => {
      const content = await readFile(resolve(path), "utf8");
      expect(jsonExamples(content)).toContainEqual(
        expect.objectContaining({
          mcpServers: expect.objectContaining({
            rea: expect.objectContaining({
              command: "npx",
              args: [
                "-y",
                PRODUCT_IDENTITY.registrationPackageSpecifier,
                "mcp",
              ],
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
      if (path.startsWith("README_"))
        expect(content).toContain("MCP-tool_catalog");
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
