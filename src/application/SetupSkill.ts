import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const canonicalSkillDestination = (home: string): string =>
  join(home, ".agents/skills", PRODUCT_IDENTITY.skillName, "SKILL.md");

const readCanonicalSkill = (): Promise<string> =>
  readFile(
    new URL(
      `../../skills/${PRODUCT_IDENTITY.skillName}/SKILL.md`,
      import.meta.url,
    ),
    "utf8",
  );

/** Determine whether setup would need to install or update the canonical skill. */
export const canonicalSkillInstallationNeeded = async (
  home: string,
): Promise<boolean> => {
  try {
    const [canonical, installed] = await Promise.all([
      readCanonicalSkill(),
      readFile(canonicalSkillDestination(home), "utf8").catch(() => undefined),
    ]);
    return installed !== canonical;
  } catch {
    // Disclose the action when setup cannot prove the installed copy is aligned.
    return true;
  }
};

/** Transactionally install or upgrade the versioned canonical REA skill. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  const destination = canonicalSkillDestination(home);
  const backup = `${destination}.rea.backup`;
  let original: string | undefined;
  try {
    const content = await readCanonicalSkill();
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
