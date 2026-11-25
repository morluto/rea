import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  readGuidanceSection,
  searchGuidance,
} from "../../src/application/GuidanceAccess.js";
import { MANAGED_SKILL_FILES } from "../../src/application/SetupSkill.js";
import { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const packaged = vi.hoisted(() => ({
  roots: new Map<string, string>(),
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
  counterpart: (path: string) =>
    packaged.roots.get(
      path.replaceAll("\\", "/").split("/").slice(-2).join("/"),
    ) ?? packaged.roots.get(path.replaceAll("\\", "/").split("/").at(-1) ?? ""),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: Parameters<typeof actual.stat>[0], ...options: unknown[]) =>
      Reflect.apply(actual.stat, undefined, [
        typeof path === "string" ? (packaged.counterpart(path) ?? path) : path,
        ...options,
      ]) as ReturnType<typeof actual.stat>,
  };
});

vi.mock("../../src/application/SetupSkill.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/application/SetupSkill.js")
    >();
  return {
    ...actual,
    readSkillFile: async (
      path: string,
      ...options: [ArtifactResourceScope?, number?]
    ) => {
      const content = await actual.readSkillFile(
        packaged.counterpart(path) ?? path,
        ...options,
      );
      await packaged.afterRead?.(path);
      return content;
    },
  };
});

afterEach(() => {
  packaged.roots.clear();
  packaged.afterRead = undefined;
});

const preparePackagedGuides = async () => {
  const root = await createTestTempDirectory("rea-packaged-guidance-cache-");
  for (const guide of MANAGED_SKILL_FILES) {
    const path = join(root, guide);
    packaged.roots.set(guide, path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      guide === "SKILL.md"
        ? "# Nebulacache\n\nStable guide content.\n"
        : "# Other guide\n\nDifferent content.\n",
    );
  }
  return join(root, "SKILL.md");
};

const locator = async (resources: ArtifactResourceScope) => {
  const result = await searchGuidance({ query: "Nebulacache" }, resources);
  if (
    !result.ok ||
    result.value.status !== "matches" ||
    result.value.matches[0] === undefined
  )
    throw new Error("Expected packaged guidance match");
  return result.value.matches[0].locator;
};

it.each(["changes", "disappears"] as const)(
  "invalidates a warm packaged locator when a guide %s",
  async (change) => {
    const guide = await preparePackagedGuides();
    const resources = new ArtifactResourceScope();
    try {
      const initial = await locator(resources);
      const readGuide = vi.fn(async () => {});
      packaged.afterRead = readGuide;
      expect(
        await readGuidanceSection({ locator: initial }, resources),
      ).toMatchObject({
        ok: true,
        value: { status: "section" },
      });
      expect(readGuide).not.toHaveBeenCalled();
      if (change === "changes") await appendFile(guide, "\nNew content.\n");
      else await unlink(guide);
      expect(
        await readGuidanceSection({ locator: initial }, resources),
      ).toMatchObject({
        ok: true,
        value: {
          status: change === "changes" ? "stale_locator" : "bundle_unavailable",
        },
      });
    } finally {
      await resources.close();
    }
  },
);

it("does not reuse text when the packaged file changed before the post-read stat", async () => {
  const guide = await preparePackagedGuides();
  const resources = new ArtifactResourceScope();
  packaged.afterRead = async (path) => {
    if (packaged.counterpart(path) !== guide) return;
    packaged.afterRead = undefined;
    await appendFile(guide, "\nChanged after the completed read.\n");
  };
  try {
    const before = await locator(resources);
    expect(
      await readGuidanceSection({ locator: before }, resources),
    ).toMatchObject({
      ok: true,
      value: { status: "stale_locator" },
    });
    const current = await locator(resources);
    expect(
      await readGuidanceSection({ locator: current }, resources),
    ).toMatchObject({
      ok: true,
      value: {
        status: "section",
        content: expect.stringContaining("Changed after"),
      },
    });
  } finally {
    await resources.close();
  }
});
