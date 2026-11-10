import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { dosMz } from "../../../src/domain/binaryTarget.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "reports DOS as unsupported for PE resources and certificates through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-dos-public-");
    const path = join(root, "dos.exe");
    const bytes = dosMz(1024);
    await writeFile(path, bytes);
    const mcp =
      surface === "stdio MCP" ? await connectLocalToolsMcp() : undefined;
    for (const operation of ["resources", "certificates"] as const) {
      let error: unknown;
      if (surface === "CLI") {
        const response = await cli.run({
          arguments: [`inspect-pe-${operation}`, path, "--json"],
        });
        expect(response.exitCode).toBe(1);
        error = response.json;
      } else {
        const response = await mcp!.call(`inspect_pe_${operation}`, { path });
        expect(response.isError).toBe(true);
        error = parseMcpToolError(response).error;
      }
      expect(error).toMatchObject({
        code: "unsupported_target",
        category: "unsupported_target",
      });
      expect(JSON.stringify(error)).not.toContain("inspect_input_contract");
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    }
  },
);
