import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const home = await mkdtemp(join(tmpdir(), "rea-skill-test-"));
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
    expect(await readFile(destination, "utf8")).toContain('version: "21"');
    expect(await readFile(destination, "utf8")).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await installCanonicalSkill(home)).toBe("unchanged");
  });

  it("backs up and retires the legacy skill name", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-skill-test-"));
    roots.push(home);
    const legacy = join(home, ".agents/skills/rea-analysis/SKILL.md");
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, "legacy managed skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(destination, "utf8")).toContain(
      "name: reverse-engineer-anything",
    );
    expect(await readFile(`${legacy}.rea.backup`, "utf8")).toBe(
      "legacy managed skill\n",
    );
    await expect(readFile(legacy, "utf8")).rejects.toThrow();
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
  });

  it("does not migrate a legacy skill through a directory symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-skill-test-"));
    roots.push(home);
    const skillsRoot = join(home, ".agents/skills");
    const external = join(home, "external-skill");
    const legacyRoot = join(skillsRoot, "rea-analysis");
    const legacy = join(legacyRoot, "SKILL.md");
    const destination = join(skillsRoot, "reverse-engineer-anything/SKILL.md");
    await mkdir(skillsRoot, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "SKILL.md"), "external skill\n");
    await symlink(
      external,
      legacyRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await installCanonicalSkill(home)).toBe("failed");
    expect(await readFile(legacy, "utf8")).toBe("external skill\n");
    await expect(readFile(destination, "utf8")).rejects.toThrow();
  });
});
