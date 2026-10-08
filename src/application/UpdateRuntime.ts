import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  updateInstallCommand,
  type NpmInstallation,
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
  latestVersion: async (installation) => {
    const response = await runUpdateCommand([
      "npm",
      "view",
      "--global",
      ...(installation === undefined ? [] : ["--prefix", installation.prefix]),
      PRODUCT_IDENTITY.packageName,
      "dist-tags.latest",
      "--json",
      "--fetch-retries=0",
      "--fetch-timeout=10000",
    ]);
    if (!response.ok) return response;
    try {
      const parsed = z
        .union([
          z.string().min(1),
          z.tuple([z.string().min(1)]).transform(([version]) => version),
        ])
        .safeParse(JSON.parse(response.value));
      return parsed.success
        ? ok(parsed.data)
        : err(`Invalid npm release metadata: ${parsed.error.message}`);
    } catch (cause: unknown) {
      return err(cause instanceof Error ? cause.message : String(cause));
    }
  },
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
