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

it("pairs elements with a long tag and many attributes in a small heap, spelling a selector only once chosen", async () => {
  // Spelling the tag into a selector per attribute needed more than 140 MiB here.
  const pairing = await inSmallHeap(
    "viewPointer.ts",
    "pairMembers",
    `const tag = "t".repeat(40_000);
const element = (id) => {
  const attributes = { id };
  for (let index = 0; index < 2000; index += 1) attributes["a" + index] = String(index);
  return { name: tag, attributes, children: [] };
};
const members = [element("1"), element("2")];
const { newer, older } = pairMembers(members, members);
console.log(JSON.stringify({ keys: newer.keys.map((key) => key.replace(tag, "T")), partners: newer.partners, same: older.keys.every((key, index) => key === newer.keys[index]) }));
`,
  );

  expect(pairing).toEqual({
    keys: ["[name=T][@id=1]", "[name=T][@id=2]"],
    partners: [0, 1],
    same: true,
  });
}, 180_000);

it("refuses JSON over the parsed-view limit in a small heap, telling it apart from text without building it", async () => {
  // Parsing the entry to detect its format needed more than 80 MiB here.
  const entries = await inSmallHeap(
    "zipView.ts",
    "zipEntry",
    `const read = (name, text) => {
  const bytes = new TextEncoder().encode(text);
  const entry = zipEntry({ name, size: bytes.length, compressedSize: bytes.length, method: 0, encrypted: false }, bytes);
  return [entry.format, entry.view_error ?? entry.view.line_count];
};
console.log(JSON.stringify([
  read("objects.json", "[{}" + ",{}".repeat(1_400_000) + "]"),
  read("objects.txt", "[{}" + ",{}".repeat(1_400_000) + "}"),
]));
`,
  );

  expect(entries).toEqual([
    ["json", "larger than the 4 MiB limit for JSON and key file views"],
    ["text", 1],
  ]);
}, 180_000);

it("scrubs UTF-16 XML and JSON seeds of a million elements in a small heap, telling their format without building them", async () => {
  // Building the XML document to choose the scrubber needed more than 768 MiB here, and parsing the JSON more than 64 MiB; the syntax checks and copying only changes run in 24 MiB.
  const outcomes = await inSmallHeap(
    "seedScrub.ts",
    "scrubSeed",
    `const scrub = (home, text, tail, clean) => {
  const seed = Buffer.from("\\uFEFF" + text + tail, "utf16le");
  const scrubbed = scrubSeed(seed, { home, format: "binary" }, { home: "/home/ada", hostname: "e81232be457d", user: "ada" });
  const expected = Buffer.concat([seed.subarray(0, -2 * tail.length), Buffer.from(clean, "utf16le")]);
  return { exact: scrubbed.bytes?.equals(expected), holdsIdentity: scrubbed.holdsIdentity };
};
console.log(JSON.stringify([
  scrub(".config/wide.xml", "<?xml version=\\"1.0\\" encoding=\\"UTF-16\\"?>\\n<r>" + "<e/>".repeat(1_000_000), "<m>ada@e81232be457d</m></r>", "<m>user@localhost</m></r>"),
  scrub(".config/wide.json", "[{}" + ",{}".repeat(1_000_000), ',"ada@e81232be457d"]', ',"user@localhost"]'),
]));
`,
  );

  expect(outcomes).toEqual([
    { exact: true, holdsIdentity: false },
    { exact: true, holdsIdentity: false },
  ]);
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
