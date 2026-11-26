import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

import { normalizeTestTemporaryPrefix } from "../../scripts/lib/test-temporary-ownership.mjs";
import { isLosslessNodeDiscoveryPath } from "../../src/inspector/nodeDiscoveryPath.js";
import { removeTestWorkspace } from "../support/workspace/workspaceFixture.js";

/**
 * Creates an empty canonical temporary directory owned by the current Vitest
 * case.
 *
 * This deliberately does not build a workspace first. It used to call
 * `createTestWorkspace`, which creates `home` and `xdg/{config,cache}`, then
 * immediately delete two of them so callers would receive an empty root. Every
 * caller therefore paid three `mkdir` calls and two `rm` calls per temporary
 * directory for scaffolding it never used. Callers that do need a home or XDG
 * tree should call `createTestWorkspace` directly.
 */
export const createTestTempDirectory = async (
  prefix: string,
): Promise<string> => {
  const canonicalDirectory = await realpath(
    await mkdtemp(
      join(await realpath(tmpdir()), normalizeTestTemporaryPrefix(prefix)),
    ),
  );
  onTestFinished(async () => {
    await removeTestWorkspace(canonicalDirectory);
  });
  return canonicalDirectory;
};

/** Write a single fixture in a fresh directory owned by the current test. */
export const createTestTempFile = async (
  prefix: string,
  name: string,
  contents: Uint8Array | string,
): Promise<string> => {
  const path = join(await createTestTempDirectory(prefix), name);
  await writeFile(path, contents);
  return path;
};

/**
 * Like `createTestTempDirectory`, for fixtures whose paths Node reports through
 * Inspector discovery metadata.
 *
 * Node replaces `"` and `\` with `_` in that metadata, so
 * `authorizeRuntimeTargetLocation` never stats a reported POSIX path containing
 * `_`, `"` or `\`. A temporary root such as macOS's per-user
 * `/private/var/folders/<x>/<y>/T`, where `<y>` often contains `_`, would make
 * every fixture unverifiable. On POSIX this uses the canonical temporary
 * directory when it is free of those characters, otherwise the canonical
 * `/tmp`, and fails when neither is. Windows keeps `createTestTempDirectory`:
 * Node discovery paths are never verified there.
 */
export const createNodeDiscoveryTempDirectory = async (
  prefix: string,
): Promise<string> => {
  if (process.platform === "win32") return createTestTempDirectory(prefix);
  const primary = await realpath(tmpdir());
  const base = isLosslessNodeDiscoveryPath(primary, process.platform)
    ? primary
    : await realpath("/tmp");
  const canonicalDirectory = await realpath(
    await mkdtemp(join(base, normalizeTestTemporaryPrefix(prefix))),
  );
  onTestFinished(async () => {
    await removeTestWorkspace(canonicalDirectory);
  });
  if (!isLosslessNodeDiscoveryPath(canonicalDirectory, process.platform))
    throw new Error(
      `No temporary directory free of '_', '"' and '\\' for Node discovery fixtures: ${canonicalDirectory}`,
    );
  return canonicalDirectory;
};
