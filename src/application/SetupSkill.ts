import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { err, ok, type Result } from "../domain/result.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  withRegularFile,
} from "./RegularFileRead.js";
import { clientSkillDirectories } from "./SupportedClients.js";

export const MANAGED_SKILL_FILES = [
  "SKILL.md",
  "references/connection-and-recovery.md",
  "references/native-and-artifacts.md",
  "references/javascript-applications.md",
  "references/android-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
] as const;

export const isManagedSkillManifest = (content: string): boolean =>
  content.startsWith(`---\nname: ${PRODUCT_IDENTITY.skillName}\n`) ||
  content.startsWith(`---\r\nname: ${PRODUCT_IDENTITY.skillName}\r\n`);

export const readSkillFile = (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<string> =>
  readSkillFileState(path, resources).then(({ content }) => content);

interface SkillFileState {
  readonly content: string;
  readonly mode: number;
}

const readSkillFileState = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<SkillFileState> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      const bytes = await readBoundedFileBytes(
        handle,
        stats.size,
        undefined,
        stats.size,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new RegularFileChangedError(path);
      return { content: bytes.toString("utf8"), mode: stats.mode & 0o7777 };
    },
    {
      symlinks: "reject",
      ...(resources === undefined ? {} : { resources }),
    },
  );

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: SkillFileState | undefined;
}

const canonicalSkillContent = (relativePath: string): Promise<string> =>
  readFile(
    new URL(
      `../../skills/${PRODUCT_IDENTITY.skillName}/${relativePath}`,
      import.meta.url,
    ),
    "utf8",
  );

export interface SkillInstallFileOperations {
  readonly mkdir: (path: string) => Promise<void>;
  readonly backup: (source: string, destination: string) => Promise<void>;
  readonly write: (
    path: string,
    content: string,
    mode: number,
  ) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export interface SkillInstallRollbackFailure {
  readonly path: string;
  readonly reason: string;
}

/** Expected failure while replacing a managed skill bundle. */
export class SetupSkillInstallError extends Error {
  readonly _tag = "SetupSkillInstallError";
  readonly path: string;
  readonly stage: "prepare" | "backup" | "write" | "readback";
  readonly reason: string;
  readonly rollbackFailures: readonly SkillInstallRollbackFailure[];
  readonly recoveryBackupPaths: readonly string[];

  constructor(input: {
    readonly path: string;
    readonly stage: "prepare" | "backup" | "write" | "readback";
    readonly reason: string;
    readonly rollbackFailures: readonly SkillInstallRollbackFailure[];
    readonly recoveryBackupPaths: readonly string[];
    readonly cause: unknown;
  }) {
    const message = [
      `REA skill ${input.stage} failed at ${input.path}: ${input.reason}.`,
      ...(input.rollbackFailures.length === 0
        ? []
        : [
            `Rollback also failed for ${input.rollbackFailures.map(({ path, reason }) => `${path} (${reason})`).join(", ")}.`,
            ...(input.recoveryBackupPaths.length === 0
              ? []
              : [
                  `Existing-file backups remain at ${input.recoveryBackupPaths.join(", ")}.`,
                ]),
          ]),
    ].join(" ");
    super(message, { cause: input.cause });
    this.path = input.path;
    this.stage = input.stage;
    this.reason = input.reason;
    this.rollbackFailures = input.rollbackFailures;
    this.recoveryBackupPaths = input.recoveryBackupPaths;
  }

  get remediation(): string {
    return `${this.message} Check permissions and rerun setup.`;
  }
}

export type SkillInstallValue = "installed" | "unchanged";
export type SkillInstallResult = Result<
  SkillInstallValue,
  SetupSkillInstallError
>;

const systemSkillInstallFileOperations: SkillInstallFileOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  backup: async (source, destination) => {
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
        return;
      throw cause;
    }
  },
  write: (path, content, mode) =>
    writeFileAtomic(path, content, { encoding: "utf8", mode }),
  remove: (path) => rm(path, { force: true }),
};

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

/** Resolve existing REA-owned skill roots using setup's canonical destinations. */
export const existingSkillDestinations = async (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<readonly SkillDestination[]> => {
  const existing: SkillDestination[] = [];
  for (const destination of skillDestinations(
    home,
    undefined,
    environment,
    platform,
  )) {
    try {
      const root = await lstat(destination.path);
      if (root.isSymbolicLink() || !root.isDirectory()) continue;
      const manifest = join(destination.path, "SKILL.md");
      const content = await readSkillFile(manifest, resources);
      if (isManagedSkillManifest(content)) existing.push(destination);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      if (
        cause instanceof RegularFileCleanupFailure ||
        cause instanceof ArtifactReaderFailure
      )
        throw cause;
      if (cause instanceof NonRegularFileReadError) continue;
      throw cause;
    }
  }
  return existing;
};

const readOptionalSkillState = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<SkillFileState | undefined> => {
  try {
    return await readSkillFileState(path, resources);
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
  resources?: ArtifactResourceScope,
): Promise<readonly CanonicalSkillFile[]> =>
  Promise.all(
    skillDestinations(home, clientIds, environment, platform).flatMap(
      ({ path: root }) =>
        MANAGED_SKILL_FILES.map(async (relativePath) => {
          const destination = join(root, relativePath);
          return {
            destination,
            content: await canonicalSkillContent(relativePath),
            original: await readOptionalSkillState(destination, resources),
          };
        }),
    ),
  );

const canonicalSkillNeedsInstallByReading = async (
  home: string,
  clientIds: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  resources?: ArtifactResourceScope,
): Promise<boolean> => {
  for (const { path: root } of skillDestinations(
    home,
    clientIds,
    environment,
    platform,
  )) {
    for (const relativePath of MANAGED_SKILL_FILES) {
      const destination = join(root, relativePath);
      const content = await canonicalSkillContent(relativePath);
      const original = await readOptionalSkillState(destination, resources);
      if (original?.content !== content) return true;
    }
  }
  return false;
};

/** Report whether setup would change any file in the managed REA skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
  clientIds: readonly string[] = [],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<boolean> => {
  try {
    return await canonicalSkillNeedsInstallByReading(
      home,
      clientIds,
      environment,
      platform,
      resources,
    );
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure ||
      cause instanceof ArtifactReaderFailure
    )
      throw cause;
    // Unreadable skill state fails open to install so setup can repair it.
    void cause;
    return true;
  }
};

const causeReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const causePath = (cause: unknown): string | undefined =>
  cause instanceof Error && "path" in cause && typeof cause.path === "string"
    ? cause.path
    : undefined;

const restoreSkillFiles = async (
  attempted: readonly CanonicalSkillFile[],
  operations: SkillInstallFileOperations,
): Promise<readonly SkillInstallRollbackFailure[]> => {
  const failures: SkillInstallRollbackFailure[] = [];
  for (const { destination, original } of [...attempted].reverse()) {
    try {
      if (original === undefined) await operations.remove(destination);
      else await operations.write(destination, original.content, original.mode);
    } catch (cause: unknown) {
      failures.push({ path: destination, reason: causeReason(cause) });
    }
  }
  return failures;
};

/** Transactionally install the canonical skill bundle and optional references. */
export const installCanonicalSkill = async (
  home: string,
  clientIds: readonly string[] = [],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  operations: SkillInstallFileOperations = systemSkillInstallFileOperations,
  resources?: ArtifactResourceScope,
): Promise<SkillInstallResult> => {
  let attempted: CanonicalSkillFile[] = [];
  let stage: "prepare" | "backup" | "write" | "readback" = "prepare";
  let failingPath = "skill bundle";
  try {
    const canonical = await canonicalSkillFiles(
      home,
      clientIds,
      environment,
      platform,
      resources,
    );
    const changed = canonical.filter(
      ({ content, original }) => original?.content !== content,
    );
    if (changed.length === 0) return ok("unchanged");

    stage = "backup";
    for (const { destination, original } of changed) {
      failingPath = destination;
      await operations.mkdir(dirname(destination));
      if (original !== undefined)
        await operations.backup(destination, `${destination}.rea.backup`);
    }
    stage = "write";
    for (const file of changed) {
      failingPath = file.destination;
      // An atomic writer can publish and then reject; include the target before
      // entering it so rollback covers that ambiguous outcome.
      attempted.push(file);
      await operations.write(
        file.destination,
        file.content,
        file.original?.mode ?? 0o600,
      );
    }
    stage = "readback";
    for (const { destination, content } of changed) {
      failingPath = destination;
      if ((await readSkillFile(destination, resources)) !== content)
        throw new Error(`skill readback mismatch: ${destination}`);
    }
    return ok("installed");
  } catch (cause: unknown) {
    failingPath = causePath(cause) ?? failingPath;
    const rollbackFailures = await restoreSkillFiles(attempted, operations);
    return err(
      new SetupSkillInstallError({
        path: failingPath,
        stage,
        reason: causeReason(cause),
        rollbackFailures,
        recoveryBackupPaths: attempted.flatMap(({ destination, original }) =>
          original === undefined ? [] : [`${destination}.rea.backup`],
        ),
        cause,
      }),
    );
  }
};

/** Read installed skill metadata and compare every managed location. */
export const readInstalledSkillIdentity = async (
  home: string,
  clientIds: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
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
      content = await readSkillFile(
        join(destination.path, "SKILL.md"),
        resources,
      );
      break;
    } catch (cause: unknown) {
      if (
        cause instanceof RegularFileCleanupFailure ||
        cause instanceof ArtifactReaderFailure
      )
        throw cause;
      // Another selected copy may provide metadata; canonical validation below
      // still marks missing or unreadable copies as stale.
    }
  }
  if (content === undefined) return undefined;
  const toolCount = /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
  let canonical: boolean;
  try {
    canonical = !(await canonicalSkillNeedsInstall(
      home,
      clientIds,
      environment,
      platform,
      resources,
    ));
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    canonical = false;
  }
  return {
    canonical,
    version: /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null,
    toolCount: toolCount === undefined ? null : Number.parseInt(toolCount, 10),
  };
};
