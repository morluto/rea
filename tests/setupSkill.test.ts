import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
} from "../src/application/Setup.js";
import { TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("canonical skill transaction", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await createTestTempDirectory("rea-skill-test-");
    roots.push(home);
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    const installedSkill = await readFile(destination, "utf8");
    expect(installedSkill).toContain('version: "23"');
    expect(installedSkill).toContain(
      "use normal repository tools and do not run REA",
    );
    expect(installedSkill).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(
      await readFile(
        join(
          home,
          ".agents/skills/reverse-engineer-anything/references/javascript-applications.md",
        ),
        "utf8",
      ),
    ).toContain("analyze_javascript_application");
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await installCanonicalSkill(home)).toBe("unchanged");
  });
});
