import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
} from "../../../src/application/SetupSkill.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

describe("canonical skill transaction", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await createTestTempDirectory("rea-skill-test-");
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    const nativeGuide = join(
      dirname(destination),
      "references/native-and-artifacts.md",
    );
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(nativeGuide), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(nativeGuide, "stale filesystem-write permission grant\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    const installedSkill = await readFile(destination, "utf8");
    expect(installedSkill).toBe(
      await readFile(
        new URL(
          "../../../skills/reverse-engineer-anything/SKILL.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(installedSkill).toContain(
      `version: "${PRODUCT_IDENTITY.skillVersion}"`,
    );
    expect(installedSkill).toContain("call available analysis tools");
    expect(installedSkill).toContain("obtain approval before setup writes");
    expect(await readFile(`${nativeGuide}.rea.backup`, "utf8")).toBe(
      "stale filesystem-write permission grant\n",
    );
    for (const reference of [
      "native-and-artifacts.md",
      "runtime-observation.md",
      "evidence-workflows.md",
    ]) {
      const installed = await readFile(
        join(dirname(destination), "references", reference),
        "utf8",
      );
      expect(installed).toBe(
        await readFile(
          new URL(
            `../../../skills/reverse-engineer-anything/references/${reference}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(installed).not.toMatch(
        /filesystem-write permission grant|native_mount_approved|only with explicit approval|Obtain the per-call/u,
      );
    }
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
