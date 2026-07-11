import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../src/identity.js";

describe("package identity", () => {
  it("keeps the manifest, executable, and floating MCP command aligned", async () => {
    const packageJson = z
      .object({ name: z.string(), bin: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(
          await readFile(
            fileURLToPath(new URL("../package.json", import.meta.url)),
            "utf8",
          ),
        ),
      );
    expect(packageJson.name).toBe(PRODUCT_IDENTITY.packageName);
    expect(Object.keys(packageJson.bin)).toEqual([PRODUCT_IDENTITY.cliBinary]);
    expect(PRODUCT_IDENTITY.mcpCommand).toBe(`npx -y ${packageJson.name} mcp`);
  });
});
