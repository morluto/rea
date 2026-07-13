import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

/** Transactionally install or upgrade the versioned canonical REA skill. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  const destination = join(
    home,
    ".agents/skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  );
  const backup = `${destination}.rea.backup`;
  let original: string | undefined;
  try {
    const content = await readFile(
      new URL(
        `../../skills/${PRODUCT_IDENTITY.skillName}/SKILL.md`,
        import.meta.url,
      ),
      "utf8",
    );
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
