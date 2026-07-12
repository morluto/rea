import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../src/", import.meta.url);

describe("provider-neutral architecture", () => {
  it("keeps Hopper imports behind its adapter and composition root", async () => {
    const forbiddenRoots = ["domain", "contracts", "server", "application"];
    const violations: string[] = [];
    for (const root of forbiddenRoots) {
      for (const file of await typescriptFiles(
        fileURLToPath(new URL(`${root}/`, sourceRoot)),
      )) {
        if (root === "application" && file.endsWith("/runtime.ts")) continue;
        const source = await readFile(file, "utf8");
        if (/from\s+["'][^"']*\/hopper\//u.test(source)) {
          violations.push(relative(fileURLToPath(sourceRoot), file));
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

const typescriptFiles = async (
  directory: string,
): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
};
