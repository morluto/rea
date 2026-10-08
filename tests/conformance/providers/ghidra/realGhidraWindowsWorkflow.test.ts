import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("real Windows Ghidra workflow trust boundary", () => {
  it("runs only default-branch code on the fixed self-hosted environment", async () => {
    const workflow = parse(
      await readFile(
        new URL(
          "../../../../.github/workflows/real-ghidra-windows.yml",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(workflow.on).toEqual({
      repository_dispatch: { types: ["real-ghidra-windows"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow).toMatchObject({
      jobs: {
        verify: {
          if: "github.ref == 'refs/heads/main'",
          environment: "real-ghidra-windows",
          "runs-on": expect.arrayContaining(["self-hosted", "Windows", "x64"]),
          steps: expect.arrayContaining([
            expect.objectContaining({
              uses: expect.stringMatching(
                /^actions\/setup-node@[a-f0-9]{40}$/u,
              ),
            }),
            expect.objectContaining({ run: "npx --yes npm@11.16.0 ci" }),
            expect.objectContaining({
              env: { REA_ANALYSIS_PROVIDER: "ghidra" },
              run: "npm run verify:ghidra:windows | Tee-Object -FilePath windows-ghidra-proof.log",
            }),
            expect.objectContaining({
              uses: expect.stringMatching(
                /^actions\/upload-artifact@[a-f0-9]{40}$/u,
              ),
              with: expect.objectContaining({
                path: expect.stringContaining("windows-ghidra-proof.log"),
              }),
            }),
          ]),
        },
      },
    });
  });
});
