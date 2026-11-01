import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("docs/verification");
const output = resolve("docs/.vitepress/dist/verification");
const records = (await readdir(source)).filter((name) =>
  name.endsWith(".json"),
);
if (records.length === 0)
  throw new Error("Verification JSON inventory is empty");
for (const record of records) {
  const expected = await readFile(resolve(source, record));
  const actual = await readFile(resolve(output, record));
  if (!expected.equals(actual))
    throw new Error(`Built verification record differs from source: ${record}`);
}
console.log(`Verified ${records.length} copied verification JSON records`);
