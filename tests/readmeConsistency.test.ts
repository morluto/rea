import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../src/contracts/nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../src/contracts/artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "../src/contracts/managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../src/contracts/managedWorkflowToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "../src/contracts/browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../src/contracts/electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../src/contracts/applicationToolContracts.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../src/identity.js";

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
  MANAGED_TOOL_CONTRACTS.length + MANAGED_WORKFLOW_TOOL_CONTRACTS.length,
  BROWSER_TOOL_CONTRACTS.length,
  ELECTRON_TOOL_CONTRACTS.length,
  APPLICATION_TOOL_CONTRACTS.length,
  SESSION_TOOL_CONTRACTS.length,
] as const;

const toolCountsFromReadme = (content: string, path: string): number[] => {
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!/^\|\s*-/u.test(line)) continue;
    const counts: number[] = [];
    for (const row of lines.slice(index + 1)) {
      if (!row.trim().startsWith("|")) break;
      const count = Number(row.split("|")[2]?.trim());
      if (!Number.isInteger(count)) break;
      counts.push(count);
    }
    if (counts.length === expectedToolCounts.length) return counts;
  }
  throw new Error(`Missing tool-family inventory table in ${path}`);
};

describe("localized README product facts", () => {
  it.each(readmes)(
    "keeps commands and requirements aligned in %s",
    async (path) => {
      const content = await readFile(resolve(path), "utf8");
      expect(content).toContain(
        "curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash",
      );
      expect(content).toContain("npx rea-agents setup");
      expect(content).toContain("npx -y rea-agents@latest doctor");
      expect(content).toContain("rea uninstall");
      expect(content).toContain(
        `"args": ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]`,
      );
      expect(content).toContain("Node.js 22");
      expect(content).toContain("macOS 12");
      expect(content).toContain("Ubuntu 24.04");
      expect(content).toContain("Fedora 41");
      expect(content).toContain("Arch Linux");
      for (const client of SUPPORTED_CLIENT_DEFINITIONS)
        expect(content).toContain(client.displayName);
      if (path === "README_ar.md")
        expect(content).toContain("Windows غير مدعوم حاليًا");
      expect(content).toContain("MCP-tool_catalog");
      expect(toolCountsFromReadme(content, path)).toEqual(expectedToolCounts);
    },
  );

  it("keeps both English CLI onboarding paths discoverable", async () => {
    const content = await readFile(resolve("README.md"), "utf8");
    expect(content).toContain("npx -y rea-agents@latest analyze");
    expect(content).toContain("npm install rea-agents` without `--global`");
    expect(content).toContain("npm install --global rea-agents");
    expect(content).toContain("rea setup");
    expect(content).toContain("--install-hopper");
    expect(content).toContain("docs/installation.md");
    expect(content).toContain("You do not need both");
  });
});
