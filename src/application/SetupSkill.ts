import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const skillDestination = (home: string, name: string): string =>
  join(home, ".agents/skills", name, "SKILL.md");

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const canonicalSkillFiles = async (
  home: string,
): Promise<{ readonly content: string; readonly destination: string }> => ({
  destination: skillDestination(home, PRODUCT_IDENTITY.skillName),
  content: await readFile(
    new URL(
      `../../skills/${PRODUCT_IDENTITY.skillName}/SKILL.md`,
      import.meta.url,
    ),
    "utf8",
  ),
});

/** Report whether setup would change the managed REA skill. */
export const canonicalSkillNeedsInstall = async (
  home: string,
): Promise<boolean> => {
  try {
    const { content, destination } = await canonicalSkillFiles(home);
    if ((await readOptionalText(destination)) !== content) return true;
    for (const name of PRODUCT_IDENTITY.legacySkillNames)
      if ((await readOptionalText(skillDestination(home, name))) !== undefined)
        return true;
    return false;
  } catch {
    return true;
  }
};

/** Transactionally install or upgrade the versioned canonical REA skill. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let destination = skillDestination(home, PRODUCT_IDENTITY.skillName);
  let backup = `${destination}.rea.backup`;
  let original: string | undefined;
  let canonicalChanged = false;
  const removedLegacy: Array<{
    readonly content: string;
    readonly destination: string;
  }> = [];
  try {
    const canonical = await canonicalSkillFiles(home);
    destination = canonical.destination;
    backup = `${destination}.rea.backup`;
    const { content } = canonical;
    original = await readOptionalText(destination);
    const legacy: Array<{
      readonly content: string;
      readonly destination: string;
    }> = [];
    for (const name of PRODUCT_IDENTITY.legacySkillNames) {
      const legacyDestination = skillDestination(home, name);
      const legacyContent = await readOptionalText(legacyDestination);
      if (legacyContent !== undefined) {
        if ((await lstat(dirname(legacyDestination))).isSymbolicLink())
          throw new Error("legacy skill directory is a symbolic link");
        legacy.push({ content: legacyContent, destination: legacyDestination });
      }
    }
    if (original === content && legacy.length === 0) return "unchanged";
    await mkdir(dirname(destination), { recursive: true });
    if (original !== undefined && original !== content)
      await writeFileAtomic(backup, original, {
        encoding: "utf8",
        mode: 0o600,
      });
    canonicalChanged = original !== content;
    if (canonicalChanged)
      await writeFileAtomic(destination, content, {
        encoding: "utf8",
        mode: 0o600,
      });
    if ((await readFile(destination, "utf8")) !== content)
      throw new Error("skill readback mismatch");
    for (const legacySkill of legacy) {
      await writeFileAtomic(
        `${legacySkill.destination}.rea.backup`,
        legacySkill.content,
        { encoding: "utf8", mode: 0o600 },
      );
      await rm(legacySkill.destination, { force: true });
      removedLegacy.push(legacySkill);
    }
    return "installed";
  } catch {
    try {
      if (canonicalChanged && original === undefined)
        await rm(destination, { force: true });
      else if (canonicalChanged && original !== undefined)
        await writeFileAtomic(destination, original, {
          encoding: "utf8",
          mode: 0o600,
        });
    } catch {
      // The canonical backup remains beside the skill for operator recovery.
    }
    for (const legacySkill of removedLegacy)
      try {
        await mkdir(dirname(legacySkill.destination), { recursive: true });
        await writeFileAtomic(legacySkill.destination, legacySkill.content, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch {
        // The legacy backup remains beside the skill for operator recovery.
      }
    return "failed";
  }
};
