import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { expect } from "vitest";

import { npmInvocation } from "../../../scripts/lib/npm-invocation.mjs";
import { processTest as test } from "../../support/process/processFixture.js";

test("packs the local license texts linked from the shipped notices", async ({
  processes,
}) => {
  // Inspect npm's actual selection without running prepack or creating a tarball.
  const npm = npmInvocation(
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    process.env,
  );
  const packed = await processes.run(npm.command, npm.arguments);
  expect(packed.exitCode, packed.stderr).toBe(0);
  const [{ files }] = JSON.parse(packed.stdout) as [
    { files: { path: string }[] },
  ];
  const paths = new Set(files.map(({ path }) => path));
  for (const document of ["THIRD_PARTY_NOTICES.md", "licenses/README.md"]) {
    expect(paths.has(document)).toBe(true);
    const text = await readFile(document, "utf8");
    const notices = [...text.matchAll(/\]\(([^)]+)\)/gu)]
      .map((match) => match[1]!)
      .filter(
        (link) =>
          !link.includes(":") && /(?:\.txt|LICENSE(?:\.md)?)$/u.test(link),
      );
    expect(notices.length).toBeGreaterThan(0);
    for (const link of notices) {
      const target = posix.normalize(posix.join(posix.dirname(document), link));
      expect(
        paths.has(target),
        `${document} links to unpacked notice ${target}`,
      ).toBe(true);
    }
  }
});
