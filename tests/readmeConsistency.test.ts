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
import { MANAGED_TOOL_CONTRACTS } from "../src/contracts/managedToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "../src/contracts/browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../src/contracts/electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../src/contracts/applicationToolContracts.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../src/application/SupportedClients.js";

const readmes = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
] as const;

const expectedToolCounts = [
  OFFICIAL_TOOL_CONTRACTS.length,
  ENHANCED_TOOL_CONTRACTS.length,
  NATIVE_TOOL_CONTRACTS.length,
  ARTIFACT_TOOL_CONTRACTS.length,
  MANAGED_TOOL_CONTRACTS.length,
  BROWSER_TOOL_CONTRACTS.length,
  ELECTRON_TOOL_CONTRACTS.length,
  APPLICATION_TOOL_CONTRACTS.length,
  SESSION_TOOL_CONTRACTS.length,
] as const;

const toolCountsFromReadme = (content: string, path: string): number[] => {
  const lines = content.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) =>
    new RegExp(`^## .*${String(TOOL_CONTRACTS.length)}`, "u").test(line),
  );
  if (headingIndex === -1)
    throw new Error(
      `Missing ${String(TOOL_CONTRACTS.length)}-tool heading in ${path}`,
    );

  const counts: number[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const countCell = cells[2];
    if (countCell === undefined)
      throw new Error(`Malformed table row in ${path}`);
    const count = Number(countCell);
    if (!Number.isInteger(count)) {
      if (counts.length === 0) continue;
      throw new Error(`Non-numeric tool count in ${path}`);
    }
    counts.push(count);
  }
  return counts;
};

describe("localized README product facts", () => {
  it.each(readmes)(
    "keeps commands and requirements aligned in %s",
    async (path) => {
      const content = await readFile(resolve(path), "utf8");
      expect(content).toContain("npx skills add morluto/rea");
      expect(content).toContain(
        "curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash",
      );
      expect(content).toContain("npx -y rea-agents setup");
      expect(content).toContain("npx -y rea-agents doctor");
      expect(content).toContain("rea uninstall");
      expect(content).toContain('"args": ["-y", "rea-agents", "mcp"]');
      expect(content).toContain("Node.js 22");
      expect(content).toContain("macOS 12");
      expect(content).toContain("Ubuntu 24.04");
      expect(content).toContain("Fedora 41");
      expect(content).toContain("Arch Linux");
      for (const client of SUPPORTED_CLIENT_DEFINITIONS)
        expect(content).toContain(client.displayName);
      if (path === "README_ar.md")
        expect(content).toContain("Windows غير مدعوم حاليًا");
      expect(content).toContain(`MCP_tools-${String(TOOL_CONTRACTS.length)}`);
      expect(toolCountsFromReadme(content, path)).toEqual(expectedToolCounts);
    },
  );

  it("keeps both English CLI onboarding paths discoverable", async () => {
    const content = await readFile(resolve("README.md"), "utf8");
    expect(content).toContain("npx -y rea-agents analyze");
    expect(content).toContain("npm install --global rea-agents");
    expect(content).toContain("rea setup");
    expect(content).toContain("--install-hopper");
    expect(content).toContain("docs/installation.md");
    expect(content).toContain("You do not need both");
  });
});
