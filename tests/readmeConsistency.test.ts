import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../src/contracts/nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../src/contracts/artifactToolContracts.js";

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
      expect(content).toContain(`MCP_tools-${String(TOOL_CONTRACTS.length)}`);
      for (const count of [
        OFFICIAL_TOOL_CONTRACTS.length,
        ENHANCED_TOOL_CONTRACTS.length,
        NATIVE_TOOL_CONTRACTS.length,
        ARTIFACT_TOOL_CONTRACTS.length,
        SESSION_TOOL_CONTRACTS.length,
      ])
        expect(content).toMatch(
          new RegExp(`\\|\\s*${String(count)}\\s*\\|`, "u"),
        );
    },
  );

  it("keeps both English CLI onboarding paths discoverable", async () => {
    const content = await readFile(resolve("README.md"), "utf8");
    expect(content).toContain("npx -y rea-agents analyze");
    expect(content).toContain("npm install --global rea-agents");
    expect(content).toContain("rea setup --yes");
    expect(content).toContain("You do not need both");
  });
});
