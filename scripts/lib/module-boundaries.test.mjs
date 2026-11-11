import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
