import { mkdir, readFile, rm } from "node:fs/promises";
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
    return (await readOptionalText(destination)) !== content;
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
  try {
    const canonical = await canonicalSkillFiles(home);
    destination = canonical.destination;
    backup = `${destination}.rea.backup`;
    const { content } = canonical;
    original = await readOptionalText(destination);
    if (original === content) return "unchanged";
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
    return "failed";
  }
};
