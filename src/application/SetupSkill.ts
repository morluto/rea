import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";
import { clientSkillDirectories } from "./SupportedClients.js";

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
  readonly client: string;
  readonly path: string;
}

/** Metadata and byte alignment observed in selected skill installations. */
export interface InstalledSkillIdentity {
  readonly version: string | null;
  readonly toolCount: number | null;
  readonly canonical: boolean;
}

/** Resolve the skill roots required by a client selection, or all owned roots. */
export const skillDestinations = (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): readonly SkillDestination[] =>
  clientSkillDirectories(home, clientIds, environment, platform).map(
    ({ client, directory }) => ({
      client,
      path: join(directory, PRODUCT_IDENTITY.skillName),
    }),
  );

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
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<readonly CanonicalSkillFile[]> =>
  Promise.all(
    skillDestinations(home, clientIds, environment, platform).flatMap(
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
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  try {
    return (
      await canonicalSkillFiles(home, clientIds, environment, platform)
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
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<"installed" | "unchanged" | "failed"> => {
  let changed: readonly CanonicalSkillFile[] = [];
  try {
    const canonical = await canonicalSkillFiles(
      home,
      clientIds,
      environment,
      platform,
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
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledSkillIdentity | undefined> => {
  const destinations = skillDestinations(
    home,
    clientIds,
    environment,
    platform,
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
      environment,
      platform,
    )),
    version: /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null,
    toolCount: toolCount === undefined ? null : Number.parseInt(toolCount, 10),
  };
};
