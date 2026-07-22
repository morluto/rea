import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  authorizedElectronFile,
  canonicalElectronRoots,
} from "../src/browser/ElectronFileScope.js";

describe("Electron file scope", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("accepts canonical files within a root and rejects escape forms", async () => {
    const base = await createTestTempDirectory("rea-electron-scope-");
    temporary.push(base);
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    const allowed = join(root, "index.html");
    const denied = join(outside, "secret.html");
    await writeFile(allowed, "allowed");
    await writeFile(denied, "denied");
    await symlink(denied, join(root, "escape.html"));
    const roots = await canonicalElectronRoots([root]);

    expect(
      await authorizedElectronFile(pathToFileURL(allowed).href, roots),
    ).toBe(allowed);
    expect(
      await authorizedElectronFile(pathToFileURL(denied).href, roots),
    ).toBeUndefined();
    expect(
      await authorizedElectronFile(
        pathToFileURL(join(root, "escape.html")).href,
        roots,
      ),
    ).toBeUndefined();
    expect(
      await authorizedElectronFile("file://server/share/index.html", roots),
    ).toBeUndefined();
    expect(
      await authorizedElectronFile("file:///tmp/root%2Findex.html", roots),
    ).toBeUndefined();
  });
});
