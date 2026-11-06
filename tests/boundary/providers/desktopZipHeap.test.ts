import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { emptyEntriesArchive } from "../../../src/domain/desktop/zipArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const ROOT = join(import.meta.dirname, "../../..");

it("reads a 600,000-entry archive's view in a small heap, parsing no more of its directory than it lists", async () => {
  const folder = await createTestTempDirectory("desktop-zip-heap-");
  const archive = join(folder, "wide.zip");
  await writeFile(archive, emptyEntriesArchive(600_000));
  const script = join(folder, "read.mjs");
  const reader = pathToFileURL(
    join(ROOT, "src/application/desktop/DesktopZipView.ts"),
  ).href;
  await writeFile(
    script,
    `import { readFileSync } from "node:fs";
import { readZipView } from ${JSON.stringify(reader)};
const read = await readZipView(readFileSync(process.argv[2]));
if (!read.ok) throw new Error(read.error);
console.log(JSON.stringify({ listed: read.value.entries.length, count: read.value.entry_count, truncated: read.value.truncated }));
`,
  );

  // zip.js parsing every record needed between 48 and 64 MiB here; the bounded directory reads in 24 MiB.
  const output = execFileSync(
    process.execPath,
    [
      "--max-old-space-size=36",
      "--max-semi-space-size=1",
      "--import",
      "tsx",
      script,
      archive,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );

  expect(JSON.parse(output)).toEqual({
    listed: 1000,
    count: 600_000,
    truncated: true,
  });
}, 180_000);
