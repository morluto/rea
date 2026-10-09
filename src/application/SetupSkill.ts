import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const SKILL_FILES = [
  "SKILL.md",
  "references/native-and-artifacts.md",
  "references/javascript-applications.md",
  "references/android-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
] as const;

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: string | undefined;
}

/** Managed skill location selected for a client family. */
export interface SkillDestination {
  readonly client: "shared" | "claude_code";
  readonly path: string;
}

/** Metadata and byte alignment observed in selected skill installations. */
export interface InstalledSkillIdentity {
  readonly version: string | null;
  readonly toolCount: number | null;
  readonly canonical: boolean;
}

/** Resolve Claude Code personal skills from the selected environment. */
export const claudeCodeSkillsDirectory = (
  home: string,
  environment: { readonly CLAUDE_CONFIG_DIR?: string } = {},
): string =>
  join(environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills");

/** Resolve the skill roots required by a client selection, or all owned roots. */
export const skillDestinations = (
  home: string,
  clientIds: readonly string[] | undefined,
  claudeSkillsDirectory = claudeCodeSkillsDirectory(home),
): readonly SkillDestination[] => {
  const includeClaude =
    clientIds === undefined || clientIds.includes("claude_code");
  const includeShared =
    clientIds === undefined ||
    clientIds.length === 0 ||
    clientIds.some((clientId) => clientId !== "claude_code");
  return [
    ...(includeShared
      ? [
          {
            client: "shared" as const,
            path: join(home, ".agents/skills", PRODUCT_IDENTITY.skillName),
          },
        ]
      : []),
    ...(includeClaude
      ? [
          {
            client: "claude_code" as const,
            path: join(claudeSkillsDirectory, PRODUCT_IDENTITY.skillName),
          },
        ]
      : []),
  ];
};

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
  clientIds: readonly string[],
  claudeSkillsDirectory?: string,
): Promise<readonly CanonicalSkillFile[]> =>
  Promise.all(
    skillDestinations(home, clientIds, claudeSkillsDirectory).flatMap(
      ({ path: root }) =>
        SKILL_FILES.map(async (relativePath) => {
          const destination = join(root, relativePath);
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
    ),
  );

/** Report whether setup would change any file in the managed REA skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
  clientIds: readonly string[] = [],
  claudeSkillsDirectory?: string,
): Promise<boolean> => {
  try {
    return (
      await canonicalSkillFiles(home, clientIds, claudeSkillsDirectory)
    ).some(({ content, original }) => original !== content);
  } catch (cause: unknown) {
    // Unreadable skill state fails open to install so setup can repair it.
    void cause;
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
  clientIds: readonly string[] = [],
  claudeSkillsDirectory?: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let changed: readonly CanonicalSkillFile[] = [];
  try {
    const canonical = await canonicalSkillFiles(
      home,
      clientIds,
      claudeSkillsDirectory,
    );
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
  } catch (cause: unknown) {
    // Install failure preserves the original error outcome; report cause inline.
    void cause;
    try {
      await restoreSkillFiles(changed);
    } catch (restoreCause: unknown) {
      // Per-file backups remain beside changed files for operator recovery.
      void restoreCause;
    }
    return "failed";
  }
};

/** Read installed skill metadata and compare every managed location. */
export const readInstalledSkillIdentity = async (
  home: string,
  clientIds: readonly string[],
  claudeSkillsDirectory?: string,
): Promise<InstalledSkillIdentity | undefined> => {
  const destinations = skillDestinations(
    home,
    clientIds,
    claudeSkillsDirectory,
  );
  let content: string | undefined;
  for (const destination of destinations) {
    try {
      content = await readFile(join(destination.path, "SKILL.md"), "utf8");
      break;
    } catch {
      // Another selected copy may provide metadata; canonical validation below
      // still marks missing or unreadable copies as stale.
    }
  }
  if (content === undefined) return undefined;
  const toolCount = /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
  return {
    canonical: !(await canonicalSkillNeedsInstall(
      home,
      clientIds,
      claudeSkillsDirectory,
    )),
    version: /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null,
    toolCount: toolCount === undefined ? null : Number.parseInt(toolCount, 10),
  };
};
