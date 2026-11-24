import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "explains a refused file symlink through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-link-cli-mcp-");
    const target = join(root, "file.bin");
    const selected = join(root, "selected.bin");
    await writeFile(target, "fixture");
    await symlink(target, selected);
    const { call } = await connectLocalToolsMcp();
    for (const [command, tool] of [
      ["inspect-model-artifact", "inspect_model_artifact"],
      ["inspect-gpu-code-objects", "inspect_gpu_code_objects"],
    ] as const) {
      const result = await cli.run({
        arguments: [command, selected, "--json"],
      });
      expect(result.exitCode).toBe(1);
      const mcp = await call(tool, { path: selected });
      const mcpError = parseMcpToolError(mcp).error;
      for (const error of [result.json as typeof mcpError, mcpError]) {
        expect(error.message).toContain("symbolic link");
        expect(error.message).toContain(selected);
        expect(error.remediation.action).toContain(target);
      }
    }
  },
);
