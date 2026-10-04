import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse } from "yaml";

const WORKFLOW = join(".github", "workflows", "ci.yml");

const curatedPaths = async (): Promise<string[]> => {
  const workflow = parse(await readFile(WORKFLOW, "utf8")) as {
    jobs?: Record<string, { steps?: { run?: string }[] }>;
  };
  const run = workflow.jobs?.["windows-curated"]?.steps
    ?.map((step) => step.run)
    .find((value) => value?.includes("npx vitest run"));
  expect(run, "expected a curated Windows vitest invocation").toBeDefined();
  return (
    run
      ?.split(/\s+/)
      .filter((token) => token.endsWith(".test.ts"))
      .sort() ?? []
  );
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("curated Windows test lane", () => {
  it("references only test files that exist", async () => {
    const paths = await curatedPaths();
    expect(paths.length).toBeGreaterThan(0);
    const missing = await Promise.all(
      paths.map(async (path) => ((await exists(path)) ? undefined : path)),
    );
    expect(missing.filter((path) => path !== undefined)).toEqual([]);
  }, 10_000);
});
