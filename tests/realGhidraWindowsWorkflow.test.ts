import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("real Windows Ghidra workflow trust boundary", () => {
  it("runs only default-branch code on the fixed self-hosted environment", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/real-ghidra-windows.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("types: [real-ghidra-windows]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: real-ghidra-windows");
    expect(workflow).toContain(
      "runs-on: [self-hosted, Windows, x64, ghidra-12-1-2]",
    );
    expect(workflow).not.toMatch(
      /\$\{\{\s*(?:inputs|github\.event\.(?:inputs|client_payload))\b/u,
    );
    expect(workflow).toContain("REA_ANALYSIS_PROVIDER: ghidra");
    expect(workflow).not.toContain("cache: npm");
    expect(workflow).not.toContain("npm run rebuild:native");
    expect(workflow).toContain("npm run verify:ghidra:windows");
    expect(workflow).toContain("windows-ghidra-proof.log");
  });
});
