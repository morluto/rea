import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import { HopperProvider } from "../src/hopper/HopperProvider.js";
import { silentLogger } from "../src/logger.js";

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

  it("publishes deterministic immutable Hopper capability descriptors", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const provider = new HopperProvider(config.value, silentLogger);
    const capabilities = provider.capabilities();
    expect(capabilities).toHaveLength(34);
    expect(new Set(capabilities.map(({ operation }) => operation)).size).toBe(
      capabilities.length,
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    for (const descriptor of capabilities) {
      expect(descriptor.provider).toEqual(provider.identity());
      expect(descriptor).toMatchObject({
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true,
        reason: null,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.effects)).toBe(true);
      expect(Object.isFrozen(descriptor.limits)).toBe(true);
      expect(Object.isFrozen(descriptor.limitations)).toBe(true);
    }
    expect(
      capabilities.find(({ operation }) => operation === "list_procedures"),
    ).toMatchObject({ pagination: "offset" });
    expect(
      capabilities.find(({ operation }) => operation === "set_comment"),
    ).toMatchObject({
      effects: { mutatesArtifact: true, mayWriteFilesystem: true },
    });
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
