import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const ROOT = join(import.meta.dirname, "../../..");

it("checks JSON depth with one iterator per level, so a wide array fits a small heap", async () => {
  const folder = await createTestTempDirectory("desktop-json-depth-");
  const script = join(folder, "depth.mjs");
  const formats = pathToFileURL(
    join(ROOT, "src/domain/desktop/stateFormats.ts"),
  ).href;
  await writeFile(
    script,
    `import { deeperThan } from ${JSON.stringify(formats)};
const wide = new Array(800_000).fill(null);
let nested = [];
for (let level = 0; level < 501; level += 1) nested = [nested];
console.log(JSON.stringify({ wide: deeperThan(wide, 500), edge: deeperThan(nested, 501), over: deeperThan(nested, 500) }));
`,
  );

  // Queuing a pair per member needed more than 64 MiB here; one iterator per level runs in 18 MiB.
  const output = execFileSync(
    process.execPath,
    [
      "--max-old-space-size=32",
      "--max-semi-space-size=1",
      "--import",
      "tsx",
      script,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );

  expect(JSON.parse(output)).toEqual({ wide: false, edge: false, over: true });
}, 90_000);
