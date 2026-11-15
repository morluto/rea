import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { CAPABILITY_DECLARATIONS } from "../../src/composition/capabilityDeclarations.js";
import {
  LIFECYCLE_STAGES,
  PROVIDER_LIFECYCLE_COVERAGE,
  PROVIDER_LIFECYCLE_GAPS,
} from "../support/providerLifecycleCoverage.js";

const repositoryRoot = new URL("../../", import.meta.url);

const registeredProviderIds = () =>
  [
    ...new Set(
      Object.values(CAPABILITY_DECLARATIONS).flatMap((declaration) =>
        declaration.providers.map((provider) => provider.identity.id),
      ),
    ),
  ].sort();

const tableGaps = () =>
  Object.entries(PROVIDER_LIFECYCLE_COVERAGE).flatMap(([id, entry]) =>
    LIFECYCLE_STAGES.filter((stage) => entry.stages[stage].kind === "gap").map(
      (stage) => `${id}:${stage}`,
    ),
  );

it("has exactly one entry per registered provider id", () => {
  expect(Object.keys(PROVIDER_LIFECYCLE_COVERAGE).sort()).toEqual(
    registeredProviderIds(),
  );
});

it("names an existing test file and literal test title for every covered stage", async () => {
  const missing: string[] = [];
  const sources = new Map<string, Promise<string | undefined>>();
  const source = (path: string) => {
    let pending = sources.get(path);
    if (pending === undefined) {
      pending = readFile(new URL(path, repositoryRoot), "utf8").catch(
        (cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw cause;
        },
      );
      sources.set(path, pending);
    }
    return pending;
  };
  for (const [id, entry] of Object.entries(PROVIDER_LIFECYCLE_COVERAGE)) {
    for (const stage of LIFECYCLE_STAGES) {
      const coverage = entry.stages[stage];
      if (coverage.kind !== "covered") continue;
      for (const { path, title } of coverage.tests) {
        const text = await source(path);
        if (!path.endsWith(".test.ts") || text === undefined) {
          missing.push(`${id}:${stage} missing file ${path}`);
          continue;
        }
        const literal = ['"', "'", "`"].some((quote) =>
          text.includes(`${quote}${title}${quote}`),
        );
        if (!literal)
          missing.push(`${id}:${stage} missing title in ${path}: ${title}`);
      }
    }
  }
  expect(missing).toEqual([]);
});

it("lists exactly the gap stages in the shrink-only gap list", () => {
  expect([...PROVIDER_LIFECYCLE_GAPS].sort()).toEqual(tableGaps().sort());
});
