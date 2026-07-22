import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../src/identity.js";

describe("package identity", () => {
  it("keeps the manifest, executable, and pinned MCP command aligned", async () => {
    const packageJson = z
      .object({
        name: z.string(),
        bin: z.record(z.string(), z.string()),
        scripts: z.object({
          start: z.string(),
          "metadata:check": z.string(),
          prebuild: z.string(),
          "precheck:fast": z.string(),
          "check:fast": z.string(),
          prepare: z.string(),
          prepack: z.string(),
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
    expect(packageJson.bin).toEqual({
      [PRODUCT_IDENTITY.cliBinary]: "scripts/rea.mjs",
      [PRODUCT_IDENTITY.packageName]: "scripts/rea.mjs",
    });
    expect(PRODUCT_IDENTITY.packageSpecifier).toBe(
      `${packageJson.name}@latest`,
    );
    expect(PRODUCT_IDENTITY.registrationPackageSpecifier).toBe(
      `${packageJson.name}@${PRODUCT_IDENTITY.packageVersion}`,
    );
    expect(PRODUCT_IDENTITY.mcpCommand).toBe(
      `npx -y ${packageJson.name}@${PRODUCT_IDENTITY.packageVersion} mcp`,
    );
    expect(packageJson.scripts.start).toBe("node scripts/rea.mjs mcp");
    expect(packageJson.scripts["metadata:check"]).toBe(
      "node scripts/generate-package-metadata.mjs --check",
    );
    expect(packageJson.scripts.prebuild).toBe(
      "npm run deps:check && npm run metadata:check",
    );
    expect(packageJson.scripts["precheck:fast"]).toBe("npm run deps:check");
    expect(packageJson.scripts["check:fast"]).toBe("turbo run typecheck lint");
    expect(packageJson.scripts.prepare).toBe("node scripts/prepare.mjs");
    expect(packageJson.scripts.prepack).toBe("node scripts/prepack.mjs");
  });
});
