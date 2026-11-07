import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import {
  readGuidanceSection,
  searchGuidance,
} from "../../src/application/GuidanceAccess.js";

it("finds and retrieves the selected section from the generated package bundle", async () => {
  const resources = new ArtifactResourceScope();
  try {
    const result = await searchGuidance(
      { query: "exact JavaScript module" },
      resources,
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      status: "matches",
      source: "installed_rea_guidance",
      package: expect.stringMatching(/^rea-agents@/u),
    });
    if (result.value.status !== "matches")
      throw new Error("Expected guidance matches");
    const match = result.value.matches.find(
      ({ heading }) => heading === "Read a module without repeating analysis",
    );
    expect(match).toBeDefined();
    expect(result.value.matches[0]?.heading).toBe(
      "Read a module without repeating analysis",
    );
    expect(match).toMatchObject({
      guide: "references/javascript-applications.md",
      matched_terms: expect.arrayContaining(["exact", "javascript", "module"]),
      context: expect.stringContaining("javascript-module"),
    });
    if (match === undefined) throw new Error("Expected selected guidance");

    const retrieved = await readGuidanceSection(
      { locator: match.locator },
      resources,
    );
    if (!retrieved.ok) throw retrieved.error;
    expect(retrieved.value).toMatchObject({
      status: "section",
      source: "installed_rea_guidance",
      guide: match.guide,
      heading: match.heading,
      locator: match.locator,
      content: expect.stringContaining("node_id"),
    });
  } finally {
    await resources.close();
  }
});

it("separates focused installed guidance from terms spread across a broad parent", async () => {
  const resources = new ArtifactResourceScope();
  try {
    const focused = await searchGuidance(
      { query: "Ghidra annotations" },
      resources,
    );
    if (!focused.ok) throw focused.error;
    if (focused.value.status !== "matches")
      throw new Error("Expected guidance matches");
    expect(focused.value.matches[0]).toMatchObject({
      heading: "Function annotations in Ghidra",
      match_scope: "section",
    });

    const terms = ["switch", "provider", "annotations"];
    const scattered = await searchGuidance(
      { query: terms.join(" "), limit: 20 },
      resources,
    );
    if (!scattered.ok) throw scattered.error;
    if (scattered.value.status !== "matches")
      throw new Error("Expected guidance matches");
    let checkedScattered = 0;
    for (const match of scattered.value.matches) {
      const read = await readGuidanceSection(
        { locator: match.locator },
        resources,
      );
      if (!read.ok || read.value.status !== "section")
        throw new Error("Expected a readable section");
      expect(read.value.content).toHaveLength(match.content_length);
      if (match.match_scope === "section") continue;
      checkedScattered += 1;
      const pointers = match.subsections ?? [];
      expect(pointers.length).toBeGreaterThan(0);
      for (const pointer of pointers)
        expect(
          terms.every((term) => pointer.matched_terms.includes(term)),
        ).toBe(false);
      // Every term is either in the parent's own text or behind a pointer.
      const located = new Set([
        ...(match.own_text_terms ?? []),
        ...pointers.flatMap((pointer) => pointer.matched_terms),
      ]);
      expect(terms.filter((term) => !located.has(term))).toEqual([]);
    }
    // These terms sit in different subsections of the installed guides.
    expect(checkedScattered).toBeGreaterThan(0);
  } finally {
    await resources.close();
  }
});
