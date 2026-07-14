import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const canonicalSkillFiles = async (
  home: string,
): Promise<{ readonly content: string; readonly destination: string }> => ({
  destination: join(
    home,
    ".agents/skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  ),
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
    return (await readFile(destination, "utf8")) !== content;
  } catch {
    return true;
  }
};

/** Transactionally install or upgrade the versioned canonical REA skill. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let destination = join(
    home,
    ".agents/skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  );
  let backup = `${destination}.rea.backup`;
  let original: string | undefined;
  try {
    const canonical = await canonicalSkillFiles(home);
    destination = canonical.destination;
    backup = `${destination}.rea.backup`;
    const { content } = canonical;
    original = await readFile(destination, "utf8").catch(() => undefined);
    if (original === content) return "unchanged";
    await mkdir(dirname(destination), { recursive: true });
    if (original !== undefined)
      await writeFileAtomic(backup, original, {
        encoding: "utf8",
        mode: 0o600,
      });
    await writeFileAtomic(destination, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    if ((await readFile(destination, "utf8")) !== content)
      throw new Error("skill readback mismatch");
    return "installed";
  } catch {
    try {
      if (original === undefined) await rm(destination, { force: true });
      else
        await writeFileAtomic(destination, original, {
          encoding: "utf8",
          mode: 0o600,
        });
    } catch {
      // The backup remains beside the skill for explicit operator recovery.
    }
    return "failed";
  }
};
