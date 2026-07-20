import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const SKILL_FILES = [
  "SKILL.md",
  "references/native-and-artifacts.md",
  "references/javascript-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
  "references/controlled-replay.md",
] as const;

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: string | undefined;
}

const skillRoot = (home: string): string =>
  join(home, ".agents/skills", PRODUCT_IDENTITY.skillName);

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
): Promise<readonly CanonicalSkillFile[]> =>
  Promise.all(
    SKILL_FILES.map(async (relativePath) => {
      const destination = join(skillRoot(home), relativePath);
      return {
        destination,
        content: await readFile(
          new URL(
            `../../skills/${PRODUCT_IDENTITY.skillName}/${relativePath}`,
            import.meta.url,
          ),
          "utf8",
        ),
        original: await readOptionalText(destination),
      };
    }),
  );

/** Report whether setup would change any file in the managed REA skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
): Promise<boolean> => {
  try {
    return (await canonicalSkillFiles(home)).some(
      ({ content, original }) => original !== content,
    );
  } catch {
    return true;
  }
};

const writeText = (path: string, content: string): Promise<void> =>
  writeFileAtomic(path, content, { encoding: "utf8", mode: 0o600 });

const restoreSkillFiles = async (
  changed: readonly CanonicalSkillFile[],
): Promise<void> => {
  for (const { destination, original } of [...changed].reverse()) {
    if (original === undefined) await rm(destination, { force: true });
    else await writeText(destination, original);
  }
};

/** Transactionally install or upgrade the canonical REA skill and references. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let changed: readonly CanonicalSkillFile[] = [];
  try {
    const canonical = await canonicalSkillFiles(home);
    changed = canonical.filter(({ content, original }) => original !== content);
    if (changed.length === 0) return "unchanged";

    for (const { destination, original } of changed) {
      await mkdir(dirname(destination), { recursive: true });
      if (original !== undefined)
        await writeText(`${destination}.rea.backup`, original);
    }
    for (const { destination, content } of changed)
      await writeText(destination, content);
    for (const { destination, content } of changed)
      if ((await readFile(destination, "utf8")) !== content)
        throw new Error(`skill readback mismatch: ${destination}`);
    return "installed";
  } catch {
    try {
      await restoreSkillFiles(changed);
    } catch {
      // Per-file backups remain beside changed files for operator recovery.
    }
    return "failed";
  }
};
