import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { MANAGED_SKILL_FILES } from "./SetupSkill.js";
import {
  readGuidanceSectionWithReader,
  searchGuidanceWithReader,
} from "./GuidanceAccess.js";

const reader = (text: string) => async (path: string) =>
  path === MANAGED_SKILL_FILES[0] ? text : "# Other\n";

it("does not substitute a common domain word for an unknown query subject", async () => {
  const resources = new ArtifactResourceScope();
  expect(
    await searchGuidanceWithReader(
      { query: "how do I inspect module frobnicate qzxv" },
      reader("# Modules\nInspect a module with retained facts.\n"),
      resources,
    ),
  ).toMatchObject({ ok: true, value: { status: "no_matches" } });
  await resources.close();
});

it("preserves ATX titles and retrieves colliding and long headings by locator", async () => {
  const resources = new ArtifactResourceScope();
  const long = `needle ${"x".repeat(3000)}`;
  const titles = [
    ["## C#", "C#"],
    ["## C# ###", "C#"],
    ["## C\\#", "C\\#"],
    ["   ## C#", "C#"],
    ["## C# \t ### \t", "C#"],
    ["## ###", ""],
    [`## ${long}`, long],
  ] as const;
  const sections = titles.map(
    ([line], index) => `${line}\nneedle recipe ${index}\n`,
  );
  const source = reader(sections.join("\n"));
  const result = await searchGuidanceWithReader(
    { query: "needle" },
    source,
    resources,
  );
  if (!result.ok || result.value.status !== "matches")
    throw new Error("Expected matching documentation");
  const matches = result.value.matches;
  expect(matches.map(({ heading }) => heading).sort()).toEqual(
    titles.map(([, heading]) => heading).sort(),
  );
  expect(new Set(matches.map(({ locator }) => locator)).size).toBe(
    titles.length,
  );

  for (const index of [0, 1, titles.length - 1]) {
    const match = matches.find(({ context, heading }) =>
      index === titles.length - 1
        ? heading === long
        : context.includes(`needle recipe ${index}`),
    );
    if (match === undefined) throw new Error("Expected the selected section");
    expect(
      await readGuidanceSectionWithReader(
        { locator: match.locator },
        source,
        resources,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        status: "section",
        heading: titles[index]?.[1],
        content: sections[index]?.trim(),
      },
    });
  }
  await resources.close();
});

it.each([2048, 2049])(
  "bounds the combined index across guides with %i sections each",
  async (count) => {
    const resources = new ArtifactResourceScope();
    const result = await searchGuidanceWithReader(
      { query: "needle", limit: 1 },
      async (path) =>
        path === MANAGED_SKILL_FILES[0] || path === MANAGED_SKILL_FILES[1]
          ? "# needle\n".repeat(count)
          : "",
      resources,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: count === 2048 ? "matches" : "bundle_unavailable" },
    });
    await resources.close();
  },
);

it("preserves retry cleanup errors and their live owner in both operations", async () => {
  const resources = new ArtifactResourceScope();
  const source = reader("# needle\nInstructions\n");
  const initial = await searchGuidanceWithReader(
    { query: "needle" },
    source,
    resources,
  );
  if (!initial.ok || initial.value.status !== "matches")
    throw new Error("Expected match");
  const locator = initial.value.matches[0]?.locator;
  let blocked = true;
  resources.retain({
    kind: "lease",
    resource: "guidance descriptor",
    lease: {
      release: async () => {
        if (blocked) throw new Error("still owned");
      },
    },
  });
  const retryingReader = (path: string) => resources.run(() => source(path));
  const errors = [];
  for (const result of [
    await searchGuidanceWithReader(
      { query: "needle" },
      retryingReader,
      resources,
    ),
    await readGuidanceSectionWithReader({ locator }, retryingReader, resources),
  ]) {
    if (result.ok) throw new Error("Cleanup failures must remain errors");
    expect(result.error).toMatchObject({ cleanupIncomplete: true });
    expect(result.error.cleanupResources).toContain("guidance descriptor");
    errors.push(result.error);
  }
  blocked = false;
  await resources.close();
  expect(resources.hasPending).toBe(false);
  for (const error of errors) expect(error.cleanupIncomplete).toBe(false);
});
