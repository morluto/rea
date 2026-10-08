import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const BUNDLE_MANIFEST = "bundle-manifest.json";

export interface SkillBundleManifest {
  readonly schema_version: 1;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: string | undefined;
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const verifiedSkillRoot = async (
  home: string,
  create: boolean,
): Promise<string> => {
  let current = await realpath(home);
  for (const component of [".agents", "skills", PRODUCT_IDENTITY.skillName]) {
    current = join(current, component);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory())
        throw new Error(
          `Managed skill path is not a real directory: ${current}`,
        );
    } catch (cause: unknown) {
      if (!isMissing(cause)) throw cause;
      if (!create) return current;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory())
        throw new Error(`Managed skill path was redirected: ${current}`);
    }
  }
  return current;
};

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
};

const verifyRegularFileOrMissing = async (
  path: string,
  description: string,
): Promise<void> => {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile())
      throw new Error(`${description} is not a real file: ${path}`);
  } catch (cause: unknown) {
    if (!isMissing(cause)) throw cause;
  }
};

const verifiedDestination = async (
  root: string,
  relativePath: string,
  createParents: boolean,
): Promise<string> => {
  const segments = relativePath.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const status = await lstat(parent);
      if (status.isSymbolicLink() || !status.isDirectory())
        throw new Error(
          `Managed skill parent is not a real directory: ${parent}`,
        );
    } catch (cause: unknown) {
      if (!isMissing(cause)) throw cause;
      if (!createParents) return join(root, ...segments);
      await mkdir(parent, { mode: 0o700, recursive: true });
      const created = await lstat(parent);
      if (created.isSymbolicLink() || !created.isDirectory())
        throw new Error(`Managed skill parent was redirected: ${parent}`);
    }
  }
  const destination = join(root, ...segments);
  try {
    const status = await lstat(destination);
    if (status.isSymbolicLink() || !status.isFile())
      throw new Error(`Managed skill file is not a real file: ${destination}`);
  } catch (cause: unknown) {
    if (!isMissing(cause)) throw cause;
  }
  return destination;
};

export const parseCanonicalSkillBundleManifest = (
  content: string,
): SkillBundleManifest => {
  const value: unknown = JSON.parse(content);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("skill_name" in value) ||
    value.skill_name !== PRODUCT_IDENTITY.skillName ||
    !("skill_version" in value) ||
    value.skill_version !== PRODUCT_IDENTITY.skillVersion ||
    !("files" in value) ||
    !Array.isArray(value.files)
  )
    throw new Error("Canonical skill bundle manifest is invalid");
  const files = value.files.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ) ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
      throw new Error(
        "Canonical skill bundle manifest contains an unsafe file",
      );
    return { path: entry.path, sha256: entry.sha256 };
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length)
    throw new Error("Canonical skill bundle manifest contains duplicate files");
  return { ...value, files } as SkillBundleManifest;
};

const canonicalSkillFiles = async (
  home: string,
  createRoot = false,
): Promise<readonly CanonicalSkillFile[]> => {
  const root = await verifiedSkillRoot(home, createRoot);
  const manifestContent = await readFile(
    new URL(
      `../../skills/${PRODUCT_IDENTITY.skillName}/${BUNDLE_MANIFEST}`,
      import.meta.url,
    ),
    "utf8",
  );
  const manifest = parseCanonicalSkillBundleManifest(manifestContent);
  const files = await Promise.all(
    manifest.files.map(async ({ path: relativePath, sha256 }) => {
      const destination = await verifiedDestination(
        root,
        relativePath,
        createRoot,
      );
      const content = await readFile(
        new URL(
          `../../skills/${PRODUCT_IDENTITY.skillName}/${relativePath}`,
          import.meta.url,
        ),
        "utf8",
      );
      if (createHash("sha256").update(content).digest("hex") !== sha256)
        throw new Error(
          `Canonical skill bundle digest mismatch: ${relativePath}`,
        );
      return {
        destination,
        content,
        original: await readOptionalText(destination),
      };
    }),
  );
  const manifestDestination = await verifiedDestination(
    root,
    BUNDLE_MANIFEST,
    createRoot,
  );
  return [
    ...files,
    {
      destination: manifestDestination,
      content: manifestContent,
      original: await readOptionalText(manifestDestination),
    },
  ];
};

/** Report whether setup would change any file in the managed REA skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
): Promise<boolean> => {
  try {
    return (await canonicalSkillFiles(home)).some(
      ({ content, original }) => original !== content,
    );
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

/** Install the canonical skill with atomic file replacement and best-effort rollback. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let changed: readonly CanonicalSkillFile[] = [];
  try {
    const canonical = await canonicalSkillFiles(home, true);
    changed = canonical.filter(({ content, original }) => original !== content);
    if (changed.length === 0) return "unchanged";

    const backups = await Promise.all(
      changed.flatMap(({ destination, original }) =>
        original === undefined
          ? []
          : [
              (async () => {
                const backup = `${destination}.rea.backup`;
                await verifyRegularFileOrMissing(
                  backup,
                  "Managed skill backup",
                );
                return { backup, original };
              })(),
            ],
      ),
    );
    for (const { destination } of changed)
      await mkdir(dirname(destination), { recursive: true });
    for (const { backup, original } of backups)
      await writeText(backup, original);
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
