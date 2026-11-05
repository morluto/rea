import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const ROOT = join(import.meta.dirname, "../../..");

/** What a script using one export of a desktop state module prints, run in a 32 MiB V8 old space. */
const inSmallHeap = async (module: string, name: string, body: string) => {
  const folder = await createTestTempDirectory("desktop-state-heap-");
  const script = join(folder, "run.mjs");
  const url = pathToFileURL(join(ROOT, "src/domain/desktop", module)).href;
  await writeFile(
    script,
    `import { ${name} } from ${JSON.stringify(url)};\n${body}`,
  );
  const output = execFileSync(
    process.execPath,
    [
      "--max-old-space-size=32",
      "--max-semi-space-size=1",
      "--import",
      "tsx",
      script,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
  return JSON.parse(output) as unknown;
};

it("checks JSON depth with one iterator per level, so a wide array fits a small heap", async () => {
  // Queuing a pair per member needed more than 64 MiB here; one iterator per level runs in 18 MiB.
  const depths = await inSmallHeap(
    "stateFormats.ts",
    "deeperThan",
    `const wide = new Array(800_000).fill(null);
let nested = [];
for (let level = 0; level < 501; level += 1) nested = [nested];
console.log(JSON.stringify({ wide: deeperThan(wide, 500), edge: deeperThan(nested, 501), over: deeperThan(nested, 500) }));
`,
  );

  expect(depths).toEqual({ wide: false, edge: false, over: true });
}, 180_000);

it("compares objects of selector keys with arrays in a small heap, however many field sets or spellings they use", async () => {
  // An index per field set or spelling needed more than 48 MiB for either comparison here.
  const removed = await inSmallHeap(
    "stateChanges.ts",
    "diffStateViews",
    `const fields = ["f0", "f1", "f2", "f3", "f4", "f5", "f6"];
const members = Array.from({ length: 5000 }, (_, i) => Object.fromEntries(fields.map((f) => [f, f + "-" + i])));
const combinations = {};
for (let mask = 1; mask < 128; mask += 1)
  combinations[fields.filter((_, bit) => mask & (1 << bit)).map((f) => "[" + f + "=" + f + "-0]").join("")] = mask;
const named = Array.from({ length: 800 }, (_, i) => ({ name: "n" + i }));
const repeated = {};
for (let count = 1; count <= 160; count += 1) repeated["[name=n0]".repeat(count)] = count;
console.log(JSON.stringify([
  diffStateViews("json", { items: combinations }, { items: members }),
  diffStateViews("json", { items: repeated }, { items: named }),
].map((difference) => difference.removed_count)));
`,
  );

  expect(removed).toEqual([0, 0]);
}, 180_000);
