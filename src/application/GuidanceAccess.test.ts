import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import {
  readGuidanceSectionWithReader,
  searchGuidanceWithReader,
} from "./GuidanceAccess.js";

const moduleGuide = `# JavaScript applications\n\n## Read a module without repeating analysis\n\nFor an exact JavaScript module (javascript-module), select its source path and module identity:\n\n\`\`\`json\n{"node_id":"module:main.js","kind":"javascript-module"}\n\`\`\`\n`;
const guideFixture = async (path: string): Promise<string> =>
  path === "references/javascript-applications.md"
    ? moduleGuide
    : `# ${path}\n\nGeneral module guidance for pagination.\n`;

const valueOf = async (
  request: ReturnType<typeof searchGuidanceWithReader>,
) => {
  const result = await request;
  if (!result.ok) throw result.error;
  return result.value;
};

it("returns an honest no-match result and rejects empty queries and invalid bounds", async () => {
  const resources = new ArtifactResourceScope();
  expect(
    await valueOf(
      searchGuidanceWithReader(
        { query: "unlikely qzxv term" },
        guideFixture,
        resources,
      ),
    ),
  ).toMatchObject({
    status: "no_matches",
    total_matches: 0,
    message: expect.stringContaining("does not indicate"),
  });
  expect(
    await searchGuidanceWithReader({ query: "  " }, guideFixture, resources),
  ).toMatchObject({ ok: false });
  expect(
    await searchGuidanceWithReader(
      { query: "x".repeat(2049) },
      guideFixture,
      resources,
    ),
  ).toMatchObject({ ok: false });
  expect(
    await searchGuidanceWithReader(
      { query: "module", limit: 21 },
      guideFixture,
      resources,
    ),
  ).toMatchObject({ ok: false });
});

it("does not treat Markdown headings inside fenced code as section boundaries", async () => {
  const result = await valueOf(
    searchGuidanceWithReader(
      { query: "phantom-heading-token" },
      async (path) =>
        `${await guideFixture(path)}\n\n\`\`\`markdown\n# phantom-heading-token\n\`\`\`\n`,
      new ArtifactResourceScope(),
    ),
  );
  expect(result.status).toBe("matches");
  if (result.status !== "matches") throw new Error("Expected guide matches");
  expect(result.matches.map(({ heading }) => heading)).not.toContain(
    "phantom-heading-token",
  );
});

it("refuses a combined guide bundle that exceeds the byte allowance", async () => {
  const perFile = "x".repeat(1_048_576);
  const result = await searchGuidanceWithReader(
    { query: "module" },
    async (path) => (path === "SKILL.md" ? "# Module guidance" : perFile),
    new ArtifactResourceScope(),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      status: "bundle_unavailable",
      message: expect.stringContaining("4 MiB"),
    },
  });
});

it("walks the exact ordered guidance results with finite continuation", async () => {
  const resources = new ArtifactResourceScope();
  const complete = await valueOf(
    searchGuidanceWithReader(
      { query: "module", limit: 20 },
      guideFixture,
      resources,
    ),
  );
  if (complete.status !== "matches") throw new Error("Expected guide matches");
  expect(complete.has_more).toBe(false);
  expect(complete.matches.length).toBeGreaterThan(2);
  const limit = 2;
  let cursor: string | undefined;
  for (let offset = 0; offset < complete.matches.length; offset += limit) {
    if (offset > 0 && cursor === undefined)
      throw new Error("Expected the next guidance page");
    const page = await valueOf(
      searchGuidanceWithReader(
        { query: "module", limit, cursor },
        guideFixture,
        resources,
      ),
    );
    if (page.status !== "matches") throw new Error("Expected guide matches");
    const hasMore = offset + limit < complete.matches.length;
    expect(page).toMatchObject({
      matches: complete.matches.slice(offset, offset + limit),
      total_matches: complete.matches.length,
      offset,
      has_more: hasMore,
    });
    if (hasMore) expect(page.next_cursor).toEqual(expect.any(String));
    else expect(page).not.toHaveProperty("next_cursor");
    cursor = page.next_cursor;
  }
});

it("rejects malformed locators and reports changed or missing installed guides", async () => {
  const resources = new ArtifactResourceScope();
  const first = await valueOf(
    searchGuidanceWithReader(
      { query: "module", limit: 1 },
      guideFixture,
      resources,
    ),
  );
  if (
    first.status !== "matches" ||
    first.next_cursor === undefined ||
    first.matches[0] === undefined
  )
    throw new Error("Expected a section and continuation token");
  const { locator, guide } = first.matches[0];
  const cursor = first.next_cursor;
  expect(
    await readGuidanceSectionWithReader(
      { locator: "../../outside.md" },
      guideFixture,
      resources,
    ),
  ).toMatchObject({ ok: false });
  const changedReader = async (path: string) => {
    const text = await guideFixture(path);
    return path === guide ? text : `${text}\nChanged after search.\n`;
  };
  expect(
    await readGuidanceSectionWithReader({ locator }, changedReader, resources),
  ).toMatchObject({ ok: true, value: { status: "stale_locator" } });
  expect(
    await searchGuidanceWithReader(
      { query: "module", limit: 1, cursor },
      changedReader,
      resources,
    ),
  ).toMatchObject({ ok: true, value: { status: "stale_continuation" } });
  expect(
    await searchGuidanceWithReader(
      { query: "different query", cursor },
      guideFixture,
      resources,
    ),
  ).toMatchObject({ ok: false });
  expect(
    await searchGuidanceWithReader(
      { query: "module", cursor: "garbage" },
      guideFixture,
      resources,
    ),
  ).toMatchObject({ ok: false });
  resources.retain({
    kind: "lease",
    resource: "unrelated completed cleanup",
    lease: { release: async () => undefined },
  });
  const missingReader = async (): Promise<string> => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  expect(
    await searchGuidanceWithReader(
      { query: "module" },
      missingReader,
      resources,
    ),
  ).toMatchObject({ ok: true, value: { status: "bundle_unavailable" } });
  expect(
    await readGuidanceSectionWithReader({ locator }, missingReader, resources),
  ).toMatchObject({ ok: true, value: { status: "bundle_unavailable" } });
});

const nestedGuide = [
  "# Native guide",
  "",
  "Overview of native work.",
  "",
  "## Apple app resources",
  "",
  "Switch provider bundles here.",
  "",
  "## Native targets",
  "",
  "Annotations in Ghidra last until close.",
  "",
  "### Function annotations in Ghidra",
  "",
  "Rename functions; annotations last until close.",
  "",
  "## Combined recovery",
  "",
  "Recovery steps.",
  "",
  "### Step alpha",
  "",
  "Use alphaword here.",
  "",
  "### Step beta",
  "",
  "Use betaword here.",
  "",
].join("\n");
const nestedReader = async (path: string): Promise<string> =>
  path === "references/native-and-artifacts.md"
    ? nestedGuide
    : `# ${path}\n\nUnrelated guidance.\n`;
const matchesFor = async (query: string, limit = 20) => {
  const result = await valueOf(
    searchGuidanceWithReader(
      { query, limit },
      nestedReader,
      new ArtifactResourceScope(),
    ),
  );
  if (result.status !== "matches") throw new Error(`No matches: ${query}`);
  return result.matches;
};

it("reports a focused subsection without repeating every enclosing parent", async () => {
  const matches = await matchesFor("function annotations");
  expect(matches).toEqual([
    expect.objectContaining({
      heading: "Function annotations in Ghidra",
      match_scope: "section",
      matched_terms: ["function", "annotations"],
    }),
  ]);
  expect(matches[0]).not.toHaveProperty("subsections");
  expect(matches[0]).not.toHaveProperty("own_text_terms");
});

it("keeps a parent whose own text holds every term alongside its matching subsection", async () => {
  const matches = await matchesFor("annotations close");
  expect(
    matches.map(({ heading, match_scope }) => [heading, match_scope]),
  ).toEqual([
    ["Function annotations in Ghidra", "section"],
    ["Native targets", "section"],
  ]);
  expect(matches[1]?.context).not.toContain("Rename functions");
});

it("labels terms scattered across sibling subsections and points to where each occurs", async () => {
  const matches = await matchesFor("switch provider annotations");
  expect(matches).toHaveLength(1);
  const [root] = matches;
  expect(root).toMatchObject({
    heading: "Native guide",
    match_scope: "subsections",
    matched_terms: ["switch", "provider", "annotations"],
    content_length: nestedGuide.trim().length,
    own_text_terms: [],
    relevance: expect.stringContaining("no single subsection"),
  });
  expect(
    root?.subsections?.map(({ heading, matched_terms }) => [
      heading,
      matched_terms,
    ]),
  ).toEqual([
    ["Apple app resources", ["switch", "provider"]],
    ["Native targets", ["annotations"]],
  ]);
  const pointer = root?.subsections?.[0];
  if (pointer === undefined) throw new Error("Expected a subsection pointer");
  const read = await readGuidanceSectionWithReader(
    { locator: pointer.locator },
    nestedReader,
    new ArtifactResourceScope(),
  );
  expect(read).toMatchObject({
    ok: true,
    value: { status: "section", heading: "Apple app resources" },
  });
  const complete = await readGuidanceSectionWithReader(
    { locator: root?.locator },
    nestedReader,
    new ArtifactResourceScope(),
  );
  if (!complete.ok || complete.value.status !== "section")
    throw new Error("Expected the complete parent section");
  expect(complete.value.content).toHaveLength(root?.content_length ?? -1);
  expect(complete.value.content).toContain("### Step beta");
});

it("separates a parent's own terms from those found in one subsection", async () => {
  const [combined, ...rest] = await matchesFor("recovery alphaword");
  expect(rest).toEqual([]);
  expect(combined).toMatchObject({
    heading: "Combined recovery",
    match_scope: "subsections",
    own_text_terms: ["recovery"],
  });
  expect(combined?.subsections?.map(({ heading }) => heading)).toEqual([
    "Step alpha",
  ]);
});

it("ranks co-located terms before broader matches and treats heading words as own text", async () => {
  const matches = await matchesFor("alphaword betaword");
  expect(matches.map(({ heading }) => heading)).toEqual(["Combined recovery"]);
  expect(await matchesFor("apple resources")).toEqual([
    expect.objectContaining({
      heading: "Apple app resources",
      match_scope: "section",
    }),
  ]);
  // The scattered parent has a heading term and the higher score.
  const focusedFirst = await valueOf(
    searchGuidanceWithReader(
      { query: "recovery alphaword" },
      async (path) =>
        path === "SKILL.md"
          ? "# REA\n\n## Focused\n\nThe alphaword recovery recipe.\n"
          : nestedReader(path),
      new ArtifactResourceScope(),
    ),
  );
  if (focusedFirst.status !== "matches") throw new Error("Expected matches");
  expect(
    focusedFirst.matches.map(({ heading, match_scope }) => [
      heading,
      match_scope,
    ]),
  ).toEqual([
    ["Focused", "section"],
    ["Combined recovery", "subsections"],
  ]);
});

it("bounds subsection pointers and counts the remainder", async () => {
  const terms = Array.from({ length: 10 }, (_, index) => `scatterterm${index}`);
  const guide = [
    "# Scattered",
    "",
    ...terms.flatMap((term, index) => [`## Part ${index}`, "", term, ""]),
  ].join("\n");
  const result = await valueOf(
    searchGuidanceWithReader(
      { query: terms.join(" ") },
      async (path) => (path === "SKILL.md" ? guide : `# ${path}\n`),
      new ArtifactResourceScope(),
    ),
  );
  if (result.status !== "matches") throw new Error("Expected matches");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]?.subsections).toHaveLength(8);
  expect(result.matches[0]?.omitted_subsections).toBe(2);
});
