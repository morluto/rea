import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const workflows = fileURLToPath(
  new URL("../../../.github/workflows/", import.meta.url),
);
const packageJson = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
const workflowNames = async (): Promise<string[]> =>
  (await readdir(workflows)).filter(
    (entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"),
  );

it("pins every third-party GitHub Action to an immutable commit", async () => {
  const mutable: string[] = [];
  for (const name of await workflowNames()) {
    const lines = (await readFile(`${workflows}/${name}`, "utf8")).split("\n");
    lines.forEach((line, index) => {
      const reference = /\buses:\s*([^\s#]+)@([^\s#]+)/u.exec(line);
      if (reference === null || reference[1]?.startsWith("./") === true) return;
      if (!/^[a-f0-9]{40}$/u.test(reference[2] ?? ""))
        mutable.push(`${name}:${String(index + 1)} ${reference[0]}`);
    });
  }

  expect(mutable).toEqual([]);
});

it("uses the repository-pinned Node and npm toolchain for dependency installs", async () => {
  const failures: string[] = [];
  let installCount = 0;

  for (const name of await workflowNames()) {
    const lines = (await readFile(`${workflows}/${name}`, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/node-version:\s*(?:['"])?24(?:['"])?\s*$/u.test(line))
        failures.push(`${name}:${String(index + 1)} floating Node major`);
      if (/run:\s*npm ci\s*$/u.test(line))
        failures.push(`${name}:${String(index + 1)} unpinned npm install`);
      if (/run:\s*npx --yes npm@11\.16\.0 ci\s*$/u.test(line))
        installCount += 1;
    });
  }

  expect(installCount).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

it("keeps generated build output outside lint inputs", async () => {
  const manifest: unknown = JSON.parse(await readFile(packageJson, "utf8"));
  expect(manifest).toMatchObject({
    scripts: {
      lint: "oxlint --ignore-pattern='dist/**' . && npm run verify:module-boundaries",
      "lint:fix":
        "oxlint --ignore-pattern='dist/**' --fix . && npm run verify:module-boundaries",
    },
  });
});
