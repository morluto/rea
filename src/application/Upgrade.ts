import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";

const execFileAsync = promisify(execFile);
const registryResponseSchema = z.object({ version: z.string().min(1) });
const UPGRADE_COMMAND = "npm install --global rea-agents@latest";

/** Location of the global npm installation that owns the running CLI. */
export interface NpmInstallation {
  readonly prefix: string;
}

/** npm filesystem queries used to identify the installation being updated. */
export interface NpmInstallationHost {
  canonicalPath(path: string): Promise<string>;
  globalRoot(): Promise<string>;
  globalPrefix(): Promise<string>;
}

/** Output channel policy for the package manager subprocess. */
export type UpgradeOutput = "human" | "structured";

/** Effects required to inspect and update the installed CLI. */
export interface UpgradeHost {
  latestVersion(): Promise<string | undefined>;
  installation(): Promise<NpmInstallation | undefined>;
  installLatest(
    installation: NpmInstallation,
    output: UpgradeOutput,
  ): Promise<boolean>;
}

/** Caller-visible outcome of checking and updating the REA CLI. */
export type UpgradeResult =
  | {
      readonly status: "current";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly installMethod: "npm";
    }
  | {
      readonly status: "upgraded";
      readonly previousVersion: string;
      readonly latestVersion: string | null;
      readonly versionCheck: "available" | "unavailable";
      readonly installMethod: "npm";
      readonly command: typeof UPGRADE_COMMAND;
    }
  | {
      readonly status: "failed";
      readonly currentVersion: string;
      readonly latestVersion: string | null;
      readonly reason: "unknown-install-method" | "install";
      readonly remediation: string;
    };

/** Check the npm registry and update the same global REA installation. */
export const runUpgrade = async (
  currentVersion: string,
  host: UpgradeHost = systemUpgradeHost(),
  output: UpgradeOutput = "human",
): Promise<UpgradeResult> => {
  const latestVersion = await host.latestVersion();
  if (latestVersion === currentVersion)
    return {
      status: "current",
      currentVersion,
      latestVersion,
      installMethod: "npm",
    };

  const installation = await host.installation();
  if (installation === undefined)
    return {
      status: "failed",
      currentVersion,
      latestVersion: latestVersion ?? null,
      reason: "unknown-install-method",
      remediation: `Update manually with: ${UPGRADE_COMMAND}`,
    };

  if (!(await host.installLatest(installation, output)))
    return {
      status: "failed",
      currentVersion,
      latestVersion: latestVersion ?? null,
      reason: "install",
      remediation: `${UPGRADE_COMMAND} failed.`,
    };

  return {
    status: "upgraded",
    previousVersion: currentVersion,
    latestVersion: latestVersion ?? null,
    versionCheck: latestVersion === undefined ? "unavailable" : "available",
    installMethod: "npm",
    command: UPGRADE_COMMAND,
  };
};

/** Create the npm registry and subprocess effects for a production upgrade. */
export const systemUpgradeHost = (): UpgradeHost => ({
  latestVersion: async () => {
    try {
      const response = await fetch(
        `https://registry.npmjs.org/${PRODUCT_IDENTITY.packageName}/latest`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return undefined;
      const parsed = registryResponseSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.version : undefined;
    } catch {
      return undefined;
    }
  },
  installation: () =>
    detectNpmInstallation(
      fileURLToPath(new URL("../..", import.meta.url)),
      systemNpmInstallationHost,
    ),
  installLatest: ({ prefix }, output) =>
    runCommand(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        `${PRODUCT_IDENTITY.packageName}@latest`,
      ],
      output,
    ),
});

const systemNpmInstallationHost: NpmInstallationHost = {
  canonicalPath: realpath,
  globalRoot: async () =>
    (await execFileAsync("npm", ["root", "--global"])).stdout.trim(),
  globalPrefix: async () =>
    (await execFileAsync("npm", ["prefix", "--global"])).stdout.trim(),
};

/** Identify the npm prefix only when it owns the running package. */
export const detectNpmInstallation = async (
  packageRoot: string,
  host: NpmInstallationHost,
): Promise<NpmInstallation | undefined> => {
  try {
    const canonicalPackageRoot = await host.canonicalPath(packageRoot);
    const npmRoot = await host.globalRoot();
    const globalPackageRoot = await host.canonicalPath(
      resolve(npmRoot, PRODUCT_IDENTITY.packageName),
    );
    if (canonicalPackageRoot === globalPackageRoot) {
      const prefix = await host.globalPrefix();
      return prefix.length === 0 ? undefined : { prefix };
    }
    return inferUnixGlobalPrefix(canonicalPackageRoot);
  } catch {
    return inferUnixGlobalPrefix(packageRoot);
  }
};

const inferUnixGlobalPrefix = (
  packageRoot: string,
): NpmInstallation | undefined => {
  const nodeModules = dirname(packageRoot);
  const library = dirname(nodeModules);
  if (
    basename(packageRoot) !== PRODUCT_IDENTITY.packageName ||
    basename(nodeModules) !== "node_modules" ||
    basename(library) !== "lib"
  )
    return undefined;
  return { prefix: dirname(library) };
};

const runCommand = (
  command: string,
  arguments_: readonly string[],
  output: UpgradeOutput,
): Promise<boolean> =>
  new Promise((resolveResult) => {
    const child = spawn(command, [...arguments_], {
      stdio:
        output === "human" ? "inherit" : ["inherit", process.stderr, "inherit"],
    });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
