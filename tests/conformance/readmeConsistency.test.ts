import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

const shellExamples = (content: string): string[] =>
  [...content.matchAll(/```bash\s*([\s\S]*?)```/gu)].map((match) =>
    (match[1] ?? "").trim(),
  );

describe("onboarding documentation product facts", () => {
  it.each([
    ["docs/native-investigation.md", "raw-binary.md#nmos-6502"],
    ["docs/ghidra-riscv.md", "raw-binary.md"],
  ])(
    "routes raw admission guidance in %s to the owning guide",
    async (path, target) => {
      const content = await readFile(resolve(path), "utf8");
      const links = [...content.matchAll(/\]\(([^)\s]+)\)/gu)].map(
        (match) => match[1],
      );
      expect(links, path).toContain(target);
    },
  );

  it("keeps the installation MCP example aligned with the package registration command", async () => {
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
  });

  it("keeps translated onboarding commands aligned with the English examples", async () => {
    const inventory = JSON.parse(
      await readFile(resolve("website/locales/languages.json"), "utf8"),
    ) as { code: string; readme: string }[];
    const translatedReadmes = inventory
      .filter((language) => language.code !== "en")
      .map((language) => language.readme);
    expect(translatedReadmes).toContain("docs/readme/README_it.md");
    expect(translatedReadmes).toHaveLength(18);
    const english = shellExamples(await readFile(resolve("README.md"), "utf8"));
    for (const path of translatedReadmes)
      expect(
        shellExamples(await readFile(resolve(path), "utf8")),
        path,
      ).toEqual(english);
  });

  it("preserves Persian joiners in links to GitHub-rendered headings", async () => {
    const persian = await readFile(resolve("docs/readme/README_fa.md"), "utf8");
    // Confirmed against GitHub's rendered README, which retains U+200C.
    for (const heading of [
      "REA چگونه کار می‌کند",
      "چه چیزهایی را می‌توان تحلیل کرد",
      "نمونه‌های عملی",
      "پرسش‌های متداول",
      "به‌روزرسانی REA",
    ]) {
      expect(persian).toContain(`## ${heading}`);
      expect(persian).toContain(
        `](#${heading.toLowerCase().replaceAll(" ", "-")})`,
      );
    }
  });
});
