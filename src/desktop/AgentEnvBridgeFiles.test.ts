import { readdir, readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);

it("ships every agentenv helper the desktop code launches in the package", async () => {
  const files = (
    JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
      files: string[];
    }
  ).files;
  const sources = await readdir(new URL("src/desktop/", ROOT));
  const launched = new Set<string>();
  for (const source of sources.filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  ))
    for (const [, helper] of (
      await readFile(new URL(`src/desktop/${source}`, ROOT), "utf8")
    ).matchAll(/"\.\.\/\.\.\/(bridge\/agentenv\/[\w.-]+\.py)"/gu))
      launched.add(helper as string);

  expect([...launched].sort()).toEqual([
    "bridge/agentenv/capture.py",
    "bridge/agentenv/computer.py",
    "bridge/agentenv/solve.py",
    "bridge/agentenv/solve_cleanup.py",
  ]);
  for (const helper of launched) expect(files).toContain(helper);
});
