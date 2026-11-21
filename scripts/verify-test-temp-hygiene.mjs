import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isOwnedTestTemporaryName } from "./lib/test-temporary-ownership.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestPath = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");

const findOwnedEntries = async (root, directory = root) => {
  const owned = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (isOwnedTestTemporaryName(entry.name)) {
      owned.push(relative(root, path));
      continue;
    }
    if (entry.isDirectory())
      owned.push(...(await findOwnedEntries(root, path)));
  }
  return owned;
};

// Vitest's children create their temporary directories beneath this root, so
// it is a plain directory: a private root's DELETE handle would block them on
// Windows.
const fixture = await VerifierFixture.open({
  prefix: "rea-test-hygiene-",
  private: false,
});

await withVerifierFixture(fixture, async ({ path: isolatedTemporaryRoot }) => {
  const result = spawnSync(
    process.execPath,
    [vitestPath, "run", "--coverage.enabled=false", ...process.argv.slice(2)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TEMP: isolatedTemporaryRoot,
        TMP: isolatedTemporaryRoot,
        TMPDIR: isolatedTemporaryRoot,
      },
      stdio: "inherit",
    },
  );

  const failures = [];
  if (result.error !== undefined) failures.push(result.error.message);
  if (result.status !== 0) {
    failures.push(
      result.signal === null
        ? `Vitest exited with status ${String(result.status)}`
        : `Vitest exited after signal ${result.signal}`,
    );
  }

  const residues = await findOwnedEntries(isolatedTemporaryRoot);
  if (residues.length > 0) {
    failures.push(`Owned temporary residues:\n${residues.join("\n")}`);
  }

  if (failures.length > 0) throw new Error(failures.join("\n\n"));
});
process.stdout.write(
  "Test temporary-directory hygiene verified: no owned residues remain.\n",
);
