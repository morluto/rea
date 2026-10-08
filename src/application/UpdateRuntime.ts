import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

import { PRODUCT_IDENTITY } from "../identity.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  updateInstallCommand,
  type NpmInstallation,
  type ReleaseLookupFailure,
  type UpdateHost,
  type UpdateOutput,
} from "./Update.js";
import { planIntegrationMaintenance } from "./UpdateMaintenance.js";

/** npm filesystem queries used to identify the installation being updated. */
export interface NpmInstallationHost {
  canonicalPath(path: string): Promise<string>;
  globalRoot(): Promise<string>;
  globalPrefix(): Promise<string>;
}

/** Run an updater subprocess with complete diagnostics and isolated machine output. */
export const runUpdateCommand = (
  command: readonly string[],
  output: UpdateOutput = "structured",
): Promise<Result<string, string>> =>
  new Promise((resolveResult) => {
    const [executable, ...args] = command;
    if (executable === undefined) {
      resolveResult(err("No executable supplied."));
      return;
    }
    const environment = { ...process.env };
    // A fresh installed entry point must not inherit npx's invocation identity.
    delete environment.npm_command;
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (output === "human") process.stderr.write(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (output === "human") process.stderr.write(chunk);
    });
    child.once("error", (cause) => resolveResult(err(cause.message)));
    child.once("close", (code, signal) =>
      resolveResult(
        code === 0
          ? ok(stdout.trim())
          : err(
              stderr.trim() ||
                stdout.trim() ||
                (signal === null
                  ? `Process exited with code ${String(code)}.`
                  : `Process terminated by ${signal}.`),
            ),
      ),
    );
  });

const requireCommandOutput = async (
  command: readonly string[],
): Promise<string> => {
  const result = await runUpdateCommand(command);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** Resolve the global prefix only when it owns the running package. */
export const detectNpmInstallation = async (
  packageRoot: string,
  host: NpmInstallationHost,
): Promise<NpmInstallation | undefined> => {
  let canonicalPackageRoot: string;
  try {
    canonicalPackageRoot = await host.canonicalPath(packageRoot);
  } catch (cause: unknown) {
    // best-effort cleanup: optional install-location probing; unknown means not npm-managed.
    void cause;
    return undefined;
  }
  try {
    const npmRoot = await host.globalRoot();
    const globalPackageRoot = await host.canonicalPath(
      resolve(npmRoot, PRODUCT_IDENTITY.packageName),
    );
    if (canonicalPackageRoot === globalPackageRoot) {
      const prefix = await host.globalPrefix();
      return prefix.length === 0
        ? undefined
        : { prefix, packageRoot: canonicalPackageRoot };
    }
  } catch (cause: unknown) {
    // The curl installer uses a Unix prefix that may differ from npm's current default.
    void cause;
  }
  const nodeModules = dirname(canonicalPackageRoot);
  const library = dirname(nodeModules);
  if (
    basename(canonicalPackageRoot) !== PRODUCT_IDENTITY.packageName ||
    basename(nodeModules) !== "node_modules" ||
    basename(library) !== "lib"
  )
    return undefined;
  return { prefix: dirname(library), packageRoot: canonicalPackageRoot };
};

const INVALID_NPM_RELEASE_METADATA =
  "Invalid npm release metadata: expected a version string or a single-element version array.";

/** npm view arguments for dist-tags.latest, scoped to the owning prefix when known. */
export const npmLatestVersionCommand = (
  installation: NpmInstallation | undefined,
): readonly string[] => [
  "npm",
  "view",
  "--global",
  ...(installation === undefined ? [] : ["--prefix", installation.prefix]),
  PRODUCT_IDENTITY.packageName,
  "dist-tags.latest",
  "--json",
  "--fetch-retries=0",
  "--fetch-timeout=10000",
];

/**
 * Read one latest version from `npm view --json`.
 * npm 11 emits a JSON string. npm 12 emits that string as a one-element array.
 */
export const parseNpmLatestVersion = (
  metadata: string,
): Result<string, string> => {
  const decoded = safeParseJson(metadata);
  if (!decoded.ok) return err(decoded.error);
  const version = readNpmLatestVersion(decoded.value);
  return version === undefined
    ? err(INVALID_NPM_RELEASE_METADATA)
    : ok(version);
};

const readNpmLatestVersion = (value: unknown): string | undefined => {
  if (typeof value === "string") return nonemptyVersion(value);
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const only = value[0];
  return typeof only === "string" ? nonemptyVersion(only) : undefined;
};

const nonemptyVersion = (value: string): string | undefined =>
  value.length === 0 ? undefined : value;

/** Classify npm view output as a version or a lookup failure. */
export const npmReleaseLookup = (
  response: Result<string, string>,
): Result<string, ReleaseLookupFailure> => {
  if (!response.ok) return err({ kind: "unavailable", detail: response.error });
  const parsed = parseNpmLatestVersion(response.value);
  return parsed.ok
    ? ok(parsed.value)
    : err({ kind: "invalid-metadata", detail: parsed.error });
};

/** Create npm, registry, verification, and read-only maintenance effects. */
export const systemUpdateHost = (
  packageRoot = fileURLToPath(new URL("../..", import.meta.url)),
  home = homedir(),
): UpdateHost => ({
  installation: () =>
    detectNpmInstallation(packageRoot, {
      canonicalPath: realpath,
      globalRoot: () => requireCommandOutput(["npm", "root", "--global"]),
      globalPrefix: () => requireCommandOutput(["npm", "prefix", "--global"]),
    }),
  latestVersion: async (installation) =>
    npmReleaseLookup(
      await runUpdateCommand(npmLatestVersionCommand(installation)),
    ),
  installVersion: async (installation, version, output) => {
    const result = await runUpdateCommand(
      updateInstallCommand(installation, version),
      output,
    );
    return result.ok ? ok(undefined) : result;
  },
  installedVersion: (installation) =>
    runUpdateCommand([
      process.execPath,
      join(installation.packageRoot, "scripts", "rea.mjs"),
      "--version",
    ]),
  planMaintenance: (installation) =>
    planIntegrationMaintenance(
      home,
      join(installation.packageRoot, "scripts", "rea.mjs"),
      runUpdateCommand,
    ),
});
