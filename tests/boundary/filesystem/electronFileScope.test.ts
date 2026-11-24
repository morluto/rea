import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { authorizedElectronFile } from "../../../src/browser/ElectronFileScope.js";

describe("Electron file scope", () => {
  it("authorizes canonical files with URL suffixes but rejects remote paths and encoded separators", async () => {
    const base = await createTestTempDirectory("rea-electron-scope-");
    const root = join(base, "..cache");
    await mkdir(root);
    const selected = join(root, "index.html");
    const other = join(base, "other.html");
    const alias = join(root, "alias.html");
    await writeFile(selected, "selected");
    await writeFile(other, "other");
    await symlink(other, alias);
    const local = pathToFileURL(selected).href;
    for (const suffix of [
      "",
      "?next=/settings",
      "#/settings",
      "?next=%2Fsettings",
      "?next=%5Csettings",
      "#%2Fsettings",
      "#%5Csettings",
      `?${"x".repeat(70_000)}`,
    ])
      await expect(authorizedElectronFile(`${local}${suffix}`)).resolves.toBe(
        selected,
      );

    for (const path of [other, alias])
      await expect(
        authorizedElectronFile(pathToFileURL(path).href),
      ).resolves.toBe(other);
    for (const denied of [
      "file://server/share/index.html",
      ...["%2F", "%5C"].map(
        (separator) => `${pathToFileURL(root).href}${separator}index.html`,
      ),
    ])
      await expect(authorizedElectronFile(denied)).resolves.toBeUndefined();
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

  it("enforces cold and cached header admission beneath an ASAR-named directory", async () => {
    const root = await createTestTempDirectory("rea-electron-admission-");
    const source = join(root, "source");
    const parent = join(root, "parent.asar");
    await mkdir(source);
    await mkdir(parent);
    await writeFile(join(source, "index.html"), "page");
    const archive = join(parent, "app.asar");
    await createPackageWithOptions(source, archive, {});
    const bytes = await readFile(archive);
    const headerBytes = bytes.readUInt32LE(4);
    const page = pathToFileURL(join(archive, "index.html")).href;
    const authorize = (maximumBytes: number) =>
      authorizedElectronFile(page, undefined, "inspect_electron_page", {
        maximumBytes,
        source: "setting",
      });
    await expect(authorize(headerBytes - 1)).resolves.toBeUndefined();
    await expect(authorize(headerBytes)).resolves.toBe(
      join(await realpath(archive), "index.html"),
    );
    await expect(authorize(headerBytes - 1)).resolves.toBeUndefined();

    const malformed = join(root, "bad.asar");
    bytes.writeUInt32LE(0x40000000, 4);
    await writeFile(malformed, bytes);
    await expect(
      authorizedElectronFile(pathToFileURL(join(malformed, "index.html")).href),
    ).resolves.toBeUndefined();
  });
});

it("refreshes ASAR member admission after a same-size rewrite preserving modification time", async () => {
  const root = await createTestTempDirectory("rea-electron-asar-rewrite-");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "old.html"), "page");
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, {});
  const timestamp = new Date("2024-01-01T00:00:00Z");
  await utimes(archive, timestamp, timestamp);
  const before = await stat(archive);
  const oldPage = pathToFileURL(join(archive, "old.html")).href;
  const newPage = pathToFileURL(join(archive, "new.html")).href;
  expect(await authorizedElectronFile(oldPage)).toBe(
    join(await realpath(archive), "old.html"),
  );
  expect(await authorizedElectronFile(newPage)).toBeUndefined();

  await rename(join(source, "old.html"), join(source, "new.html"));
  const replacement = join(root, "replacement.asar");
  await createPackageWithOptions(source, replacement, {});
  await writeFile(archive, await readFile(replacement));
  await utimes(archive, before.atime, before.mtime);
  const after = await stat(archive);
  expect({
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtime: after.mtimeMs,
  }).toEqual({
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtime: before.mtimeMs,
  });
  expect(after.ctimeMs).not.toBe(before.ctimeMs);

  expect(await authorizedElectronFile(oldPage)).toBeUndefined();
  expect(await authorizedElectronFile(newPage)).toBe(
    join(await realpath(archive), "new.html"),
  );
});
