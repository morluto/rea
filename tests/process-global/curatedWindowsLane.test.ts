import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse } from "yaml";
import { z } from "zod";

const WORKFLOW = join(".github", "workflows", "ci.yml");

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z.array(z.object({ run: z.string().optional() })).optional(),
    }),
  ),
});

const explicitPaths = async (
  lane: "windows" | "focused",
): Promise<string[]> => {
  const workflow = workflowSchema.parse(
    parse(await readFile(WORKFLOW, "utf8")),
  );
  const runs =
    lane === "windows"
      ? (workflow.jobs["windows-curated"]?.steps
          ?.map((step) => step.run)
          .filter((value) => value?.includes("npx vitest run")) ?? [])
      : Object.values(workflow.jobs)
          .flatMap((job) => job.steps ?? [])
          .map((step) => step.run)
          .filter((value) =>
            value?.trim().startsWith("npm run test:focused -- "),
          );
  expect(
    runs.length,
    `expected explicit ${lane} CI test invocations`,
  ).toBeGreaterThan(0);
  return [
    ...new Set(
      runs.flatMap(
        (run) =>
          run?.split(/\s+/).filter((token) => token.endsWith(".test.ts")) ?? [],
      ),
    ),
  ].sort();
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("curated Windows test lane", () => {
  it("references only test files that exist", async () => {
    const paths = await explicitPaths("windows");
    expect(paths.length).toBeGreaterThan(0);
    const missing = await Promise.all(
      paths.map(async (path) => ((await exists(path)) ? undefined : path)),
    );
    expect(missing.filter((path) => path !== undefined)).toEqual([]);
  }, 10_000);
});

it("keeps every explicit focused CI test path executable after file moves", async () => {
  const paths = await explicitPaths("focused");
  expect(paths.length).toBeGreaterThan(0);
  const missing = await Promise.all(
    paths.map(async (path) => ((await exists(path)) ? undefined : path)),
  );
  expect(missing.filter((path) => path !== undefined)).toEqual([]);
}, 10_000);
