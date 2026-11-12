import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  renderBuildBundle,
  type BuildRequest,
  type ReaPayload,
} from "../../domain/desktop/appBuild.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { isLockFile } from "../../domain/desktop/appExportUnowned.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";

const START = "start_build_computer";
const MAX_KEY_BYTES = 1024 * 1024;

/** The archive the build layer unpacks REA from, as the operator configured it. */
const reaPayload = async (
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ReaPayload> => {
  const path = environment.REA_BUILD_COMPUTER_REA_ARCHIVE;
  const reason =
    "A build computer from a request needs REA_BUILD_COMPUTER_REA_ARCHIVE, the absolute path of a tar archive of a runnable REA whose one top folder holds scripts/rea.mjs, or the archive rea setup --desktop-build packs for this REA version.";
  if (
    path === undefined ||
    !isAbsolute(path) ||
    !(await stat(path).then(
      (entry) => entry.isFile(),
      () => false,
    ))
  )
    throw new AnalysisCapabilityUnavailableError(
      AGENTENV_PROVIDER,
      START,
      reason,
      {
        userMessage: reason,
        remediationAction:
          "Run rea setup --client <client> --desktop-build, or pack a built REA with its production dependencies, set REA_BUILD_COMPUTER_REA_ARCHIVE to the archive and restart REA, or start from an exported bundle folder.",
      },
    );
  return { kind: "file", path };
};

/** An apt repository's key file, read whole once it is known to be a small regular file. */
const readAptKey = async (path: string): Promise<Buffer> => {
  const refuse = (reason: string, cause?: unknown) =>
    new AnalysisInputError(START, {
      userMessage: `The apt key file ${path} ${reason}.`,
      conformsToInputContract: true,
      ...(cause === undefined ? {} : { cause }),
    });
  const entry = await stat(path).catch((cause: unknown) => {
    throw refuse("cannot be read", cause);
  });
  if (!entry.isFile() || entry.size > MAX_KEY_BYTES)
    throw refuse(
      `is not a regular file of at most ${String(MAX_KEY_BYTES)} bytes, as a signing key is`,
    );
  return readFile(path).catch((cause: unknown) => {
    throw refuse("cannot be read", cause);
  });
};

/** Write the request's build bundle into a private folder, which the computer's owner removes on close. */
const writeBuildBundle = async (
  request: BuildRequest,
  payload: ReaPayload,
  resources: ArtifactResourceScope,
): Promise<{
  readonly workspace: PrivateRuntimeRoot;
  readonly bundle: string;
  readonly name: string;
}> => {
  const key =
    request.install.kind === "apt_repository"
      ? await readAptKey(request.install.key_file)
      : undefined;
  const { name, files } = renderBuildBundle(request, payload, key);
  const workspace = await PrivateRuntimeRoot.create({
    prefix: "rea-build-computer-",
  });
  try {
    const bundle = join(workspace.path, "bundle");
    for (const file of files) {
      const target = join(bundle, file.path);
      await mkdir(dirname(target), { recursive: true });
      if (
        typeof file.content === "string" ||
        file.content instanceof Uint8Array
      )
        await writeFile(target, file.content);
      else await copyFile(file.content.copyFrom, target);
    }
    return { workspace, bundle, name };
  } catch (cause: unknown) {
    const released = await resources.release({
      kind: "private-runtime-root",
      resource: workspace.path,
      root: workspace,
    });
    if (released.kind === "failed") {
      const cleanup = resources.cleanupFailure({ kind: "failed", cause }, [
        released,
      ]);
      const error = new ProviderAdapterError(AGENTENV_PROVIDER, START, {
        cause,
        userMessage: cause instanceof Error ? cause.message : String(cause),
        cleanup: cleanup.cleanup,
      });
      bindArtifactFileCleanup(cleanup, error);
      throw error;
    }
    throw cause;
  }
};

/**
 * Render a request's build bundle, with REA's payload from the operator's
 * configuration, into a private folder the caller owns and removes.
 */
export const writeRequestBundle = async (
  request: BuildRequest,
  environment: Readonly<NodeJS.ProcessEnv>,
  resources: ArtifactResourceScope,
) => writeBuildBundle(request, await reaPayload(environment), resources);

/**
 * The lock files in a bundle folder's seeds, as `envs/<name>/seed/<home
 * path>`; none when it has no seed. A bundle records no state directories, so
 * only a profile lock's name, LibreOffice's document lock or a `<file>.lck`
 * beside a seeded file counts here.
 */
export const seededLockFiles = async (
  bundle: string,
): Promise<{
  readonly locks: readonly string[];
  readonly unreadable: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}> => {
  const environments = join(bundle, "envs");
  const unreadable: { path: string; reason: string }[] = [];
  const unavailable = (path: string, cause: unknown) => {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      unreadable.push({
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    return [];
  };
  const names = await readdir(environments).catch((cause: unknown) =>
    unavailable(environments, cause),
  );
  const locks: string[] = [];
  for (const name of names) {
    const seed = join(environments, name, "seed");
    const entries = await readdir(seed, {
      recursive: true,
      withFileTypes: true,
    }).catch((cause: unknown) => unavailable(seed, cause));
    const homes = new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          relative(seed, join(entry.parentPath, entry.name))
            .split(sep)
            .join("/"),
        ),
    );
    for (const home of homes)
      if (isLockFile(home, [], homes)) locks.push(`envs/${name}/seed/${home}`);
  }
  return { locks: locks.sort(), unreadable };
};
