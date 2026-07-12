import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readmes = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
] as const;

describe("localized README product facts", () => {
  it.each(readmes)(
    "keeps commands and requirements aligned in %s",
    async (path) => {
      const content = await readFile(resolve(path), "utf8");
      expect(content).toContain("npx skills add morluto/rea");
      expect(content).toContain("npx -y rea-agents setup --yes");
      expect(content).toContain("npx -y rea-agents doctor");
      expect(content).toContain('"args": ["-y", "rea-agents", "mcp"]');
      expect(content).toContain("Node.js 24");
      expect(content).toContain("macOS 12");
      expect(content).toMatch(/\b50\b/u);
      expect(content).toMatch(/\b33\b/u);
      expect(content).toMatch(/\b10\b/u);
      expect(content).toMatch(/\b3\b/u);
    },
  );
});
