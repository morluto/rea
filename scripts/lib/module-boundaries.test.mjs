import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { inspectModuleBoundaries } from "./module-boundaries.mjs";

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-module-boundaries-"));
  await mkdir(join(root, "src/domain"), { recursive: true });
  await mkdir(join(root, "src/composition"), { recursive: true });
  await writeFile(
    join(root, "src/composition/worker.ts"),
    "export default 1;\n",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ imports: { "#worker": "./dist/composition/worker.js" } }),
  );
  return root;
};

await test("reports a pure-layer composition import written relatively", async () => {
  const root = await fixture();
  try {
    const violations = inspectModuleBoundaries(
      "src/domain/probe.ts",
      'import worker from "../composition/worker.js";\nexport default worker;\n',
      root,
    );
    assert.deepEqual(
      violations.map(({ boundary, target }) => ({ boundary, target })),
      [{ boundary: "pure-layer", target: "src/composition/worker.js" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("reports a pure-layer composition import written through the package map", async () => {
  const root = await fixture();
  try {
    const violations = inspectModuleBoundaries(
      "src/domain/probe.ts",
      'import worker from "#worker";\nexport default worker;\n',
      root,
    );
    assert.deepEqual(
      violations.map(({ boundary, target }) => ({ boundary, target })),
      [{ boundary: "pure-layer", target: "src/composition/worker.ts" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, specifier, imports] of [
  [
    "conditional",
    "#worker",
    {
      "#worker": {
        import: "./dist/composition/worker.js",
        default: "./dist/composition/other.js",
      },
    },
  ],
  ["array", "#worker", { "#worker": ["./dist/composition/worker.js"] }],
  ["pattern", "#workers/worker", { "#workers/*": "./dist/composition/*.js" }],
]) {
  await test(`refuses an unsupported valid ${name} package map rather than skipping its edge`, async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ imports }));
      const file = "src/domain/probe.ts";
      await writeFile(
        join(root, file),
        `import ${JSON.stringify(specifier)};\n`,
      );
      // Resolve only: no worker module or authored target source is executed.
      const resolved = spawnSync(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          "--input-type=module",
          "-e",
          "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
          specifier,
          pathToFileURL(join(root, file)).href,
        ],
        { encoding: "utf8" },
      );
      if (resolved.error !== undefined) throw resolved.error;
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.equal(
        resolved.stdout.trim(),
        pathToFileURL(join(root, "dist/composition/worker.js")).href,
      );
      const checked = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../verify-module-boundaries.mjs", import.meta.url),
          ),
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      if (checked.error !== undefined) throw checked.error;
      assert.equal(checked.status, 1, checked.stdout);
      assert.match(checked.stderr, /Could not inspect src\/domain\/probe.ts/u);
      assert.match(checked.stderr, /Cannot resolve package import/u);
      assert.match(checked.stderr, /relative source import/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const target of [
  "./dist/composition/worker.js",
  "./dist/%63omposition/worker.js",
  "./%64ist/composition/worker.js",
]) {
  await test(`checks the URL-normalized source owner of ${target}`, async () => {
    const root = await fixture();
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ imports: { "#worker": target } }),
      );
      await mkdir(join(root, "src/application"), { recursive: true });
      const file = "src/application/probe.ts";
      await writeFile(join(root, file), 'import "#worker";\n');
      const resolved = spawnSync(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          "--input-type=module",
          "-e",
          "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
          "#worker",
          pathToFileURL(join(root, file)).href,
        ],
        { encoding: "utf8" },
      );
      if (resolved.error !== undefined) throw resolved.error;
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.equal(
        fileURLToPath(resolved.stdout.trim()),
        join(root, "dist/composition/worker.js"),
      );
      const checked = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../verify-module-boundaries.mjs", import.meta.url),
          ),
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      if (checked.error !== undefined) throw checked.error;
      assert.equal(checked.status, 1, checked.stdout);
      assert.match(
        checked.stderr,
        /application-composition: #worker resolves to src\/composition\/worker.ts/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
