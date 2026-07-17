import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../src/identity.js";

describe("package identity", () => {
  it("keeps the manifest, executable, and latest MCP command aligned", async () => {
    const packageJson = z
      .object({
        name: z.string(),
        bin: z.record(z.string(), z.string()),
        scripts: z.object({
          start: z.string(),
          prepare: z.string(),
          prepack: z.string(),
          prepublishOnly: z.string(),
        }),
      })
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
    expect(PRODUCT_IDENTITY.packageSpecifier).toBe(
      `${packageJson.name}@latest`,
    );
    expect(PRODUCT_IDENTITY.mcpCommand).toBe(
      `npx -y ${packageJson.name}@latest mcp`,
    );
    expect(packageJson.scripts.start).toBe("node scripts/rea.mjs mcp");
    expect(packageJson.scripts.prepare).toBe("npm run build && husky");
    expect(packageJson.scripts.prepack).toBe(
      "npm run deps:check && node scripts/generate-skill-metadata.mjs --check",
    );
    expect(packageJson.scripts.prepublishOnly).toBe(
      "npm run deps:check && node scripts/generate-skill-metadata.mjs --check",
    );
  });
});
