import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { isDirectEntrypoint } from "./CurrentEntrypointPath.js";

const temporaryScript = async (): Promise<{
  path: string;
  url: string;
}> => {
  const directory = await createTestTempDirectory("rea-entrypoint-");
  const path = join(directory, "module.js");
  await writeFile(path, "export {};\n");
  return { path, url: pathToFileURL(path).href };
};

it("matches a symlinked argv path by its real location", async () => {
  const { path, url } = await temporaryScript();
  const directory = await createTestTempDirectory("rea-entrypoint-link-");
  const link = join(directory, "link.js");
  await symlink(path, link);
  expect(isDirectEntrypoint(link, url)).toBe(true);
});

it("reports no direct run when no argv path was supplied", async () => {
  const { url } = await temporaryScript();
  expect(isDirectEntrypoint(undefined, url)).toBe(false);
});

it("reports no direct run when the argv path no longer exists", async () => {
  const { url } = await temporaryScript();
  const directory = await createTestTempDirectory("rea-entrypoint-gone-");
  expect(isDirectEntrypoint(join(directory, "missing.js"), url)).toBe(false);
});
