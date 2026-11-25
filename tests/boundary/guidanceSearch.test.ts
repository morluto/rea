import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";
import {
  readGuidanceSection,
  searchGuidance,
} from "../../src/application/GuidanceAccess.js";

it("finds focused installed guidance for switching providers with annotations", async () => {
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

    const switched = await searchGuidance(
      { query: "switch provider annotations", limit: 20 },
      resources,
    );
    if (!switched.ok) throw switched.error;
    if (switched.value.status !== "matches")
      throw new Error("Expected guidance matches");
    const match = switched.value.matches.find(
      ({ heading }) => heading === "Function annotations in Ghidra",
    );
    expect(match).toMatchObject({
      guide: "references/native-and-artifacts.md",
      match_scope: "section",
      matched_terms: expect.arrayContaining([
        "switch",
        "provider",
        "annotations",
      ]),
    });
    if (match === undefined) throw new Error("Expected Ghidra guidance");
    const read = await readGuidanceSection(
      { locator: match.locator },
      resources,
    );
    if (!read.ok) throw read.error;
    expect(read.value).toMatchObject({
      status: "section",
      heading: match.heading,
      content: expect.stringContaining("discard"),
    });
  } finally {
    await resources.close();
  }
});
