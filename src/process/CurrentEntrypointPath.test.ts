import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

import { isDirectEntrypoint } from "./CurrentEntrypointPath.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryScript = async (): Promise<{
  path: string;
  url: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-entrypoint-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "module.js");
  await writeFile(path, "export {};\n");
  return { path, url: pathToFileURL(path).href };
};

it("matches the module URL when the runtime executed the file directly", async () => {
  const { path, url } = await temporaryScript();
  expect(isDirectEntrypoint(path, url)).toBe(true);
});

it("matches a symlinked argv path by its real location", async () => {
  const { path, url } = await temporaryScript();
  const directory = await mkdtemp(join(tmpdir(), "rea-entrypoint-link-"));
  temporaryDirectories.push(directory);
  const link = join(directory, "link.js");
  await symlink(path, link);
  expect(isDirectEntrypoint(link, url)).toBe(true);
});

it("reports no direct run when the module was imported instead", async () => {
  const first = await temporaryScript();
  const second = await temporaryScript();
  expect(isDirectEntrypoint(first.path, second.url)).toBe(false);
});

it("reports no direct run when no argv path was supplied", async () => {
  const { url } = await temporaryScript();
  expect(isDirectEntrypoint(undefined, url)).toBe(false);
});

it("reports no direct run when the argv path no longer exists", async () => {
  const { url } = await temporaryScript();
  const directory = await mkdtemp(join(tmpdir(), "rea-entrypoint-gone-"));
  temporaryDirectories.push(directory);
  expect(isDirectEntrypoint(join(directory, "missing.js"), url)).toBe(false);
});
