import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { authorizedElectronFile } from "../../../src/browser/ElectronFileScope.js";

describe("Electron file scope", () => {
  it("accepts dot-prefixed child names beneath a canonical root", async () => {
    const root = await createTestTempDirectory("rea-electron-dot-child-");
    const directory = join(root, "..cache");
    await mkdir(directory);
    const path = join(directory, "index.html");
    await writeFile(path, "allowed");
    expect(await authorizedElectronFile(pathToFileURL(path).href)).toBe(path);
  });

  it("accepts explicit canonical local files and rejects remote or malformed URLs", async () => {
    const base = await createTestTempDirectory("rea-electron-scope-");
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    const allowed = join(root, "index.html");
    const denied = join(outside, "secret.html");
    await writeFile(allowed, "allowed");
    await writeFile(denied, "denied");
    await symlink(denied, join(root, "escape.html"));
    expect(await authorizedElectronFile(pathToFileURL(allowed).href)).toBe(
      allowed,
    );
    expect(await authorizedElectronFile(pathToFileURL(denied).href)).toBe(
      denied,
    );
    expect(
      await authorizedElectronFile(
        pathToFileURL(join(root, "escape.html")).href,
      ),
    ).toBe(denied);
    expect(
      await authorizedElectronFile("file://server/share/index.html"),
    ).toBeUndefined();
    expect(
      await authorizedElectronFile("file:///tmp/root%2Findex.html"),
    ).toBeUndefined();
  });

  it("resolves regular files Electron serves from inside an ASAR archive", async () => {
    const root = await createTestTempDirectory("rea-electron-asar-scope-");
    const source = join(root, "source");
    await mkdir(join(source, "build", "static"), { recursive: true });
    await mkdir(join(source, "native"));
    await writeFile(join(source, "build", "index.html"), "<p>packed</p>");
    await writeFile(join(source, "build", "static", "app.js"), "app();");
    await writeFile(join(source, "native", "addon.node"), "native");
    await writeFile(join(source, "notes.txt"), "plain");
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.node" });
    const canonical = await realpath(archive);
    const member = (...parts: string[]) =>
      pathToFileURL(join(archive, ...parts)).href;

    expect(await authorizedElectronFile(member("build", "index.html"))).toBe(
      join(canonical, "build", "index.html"),
    );
    expect(
      await authorizedElectronFile(
        `${member("build", "static", "app.js")}?isBookDoubleClicked=0#/library`,
      ),
    ).toBe(join(canonical, "build", "static", "app.js"));
    expect(await authorizedElectronFile(member("native", "addon.node"))).toBe(
      join(canonical, "native", "addon.node"),
    );
    expect(await authorizedElectronFile(member("build"))).toBeUndefined();
    expect(
      await authorizedElectronFile(member("build", "missing.html")),
    ).toBeUndefined();
    expect(
      await authorizedElectronFile(
        pathToFileURL(join(source, "notes.txt", "index.html")).href,
      ),
    ).toBeUndefined();
  });

  it("accepts file URLs with long query text", async () => {
    const root = await createTestTempDirectory("rea-electron-long-url-");
    const path = join(root, "index.html");
    await writeFile(path, "allowed");
    const value = `${pathToFileURL(path).href}?${"x".repeat(70_000)}`;

    await expect(authorizedElectronFile(value)).resolves.toBe(path);
  });
});
