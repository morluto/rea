/*
 * The update notice, its cache and its detached refresh are adapted from
 * Incur's update checks.
 * Copyright (c) 2025-present weth, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * The terminal update notice. On a terminal without an explicit format, a
 * command's output (and an unknown-command error) ends with "Update available"
 * when the cached latest version is newer than the running one. A cache older
 * than a day is marked checked and refreshed by a detached `rea
 * --incur-update-check`, which asks the npm registry for the latest version.
 * `NO_UPDATE_NOTIFIER`, `npm_config_update_notifier=false` and `CI` turn the
 * notice and the refresh off. The cache lives at
 * `$XDG_CACHE_HOME/incur/updates/<package>.json`, where earlier releases kept
 * it.
 */

/** The hidden flag of the detached refresh. */
export const UPDATE_CHECK_FLAG = "--incur-update-check";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REGISTRY_TIMEOUT_MS = 10_000;

/**
 * The selected CLI snapshot and the platform that gave its keys identity.
 * Both notice decisions and the refresh child consume this same snapshot.
 */
export interface UpdateEnvironment {
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

const variable = (environment: UpdateEnvironment, name: string) =>
  environment.variables[
    environment.platform === "win32" ? name.toUpperCase() : name
  ];

export interface AvailableUpdate {
  readonly name: string;
  readonly current: string;
  readonly latest: string;
}

interface UpdateCache {
  readonly checkedAt: number;
  readonly latest?: string;
}

interface Version {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly (bigint | string)[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const parseVersion = (version: string): Version | undefined => {
  const match = SEMVER.exec(version);
  if (match === null) return undefined;
  const prerelease: (bigint | string)[] = [];
  for (const identifier of match[4]?.split(".") ?? []) {
    if (!/^\d+$/u.test(identifier)) prerelease.push(identifier);
    else if (identifier.length > 1 && identifier.startsWith("0"))
      return undefined;
    else prerelease.push(BigInt(identifier));
  }
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease,
  };
};

/** Whether `candidate` has higher semantic-version precedence than `current`. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === undefined || now === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index]! > now.core[index]!) return true;
    if (next.core[index]! < now.core[index]!) return false;
  }
  if (next.prerelease.length === 0) return now.prerelease.length > 0;
  if (now.prerelease.length === 0) return false;
  const length = Math.max(next.prerelease.length, now.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = next.prerelease[index];
    const right = now.prerelease[index];
    if (left === undefined) return false;
    if (right === undefined) return true;
    if (left === right) continue;
    if (typeof left === "bigint" && typeof right === "string") return false;
    if (typeof left === "string" && typeof right === "bigint") return true;
    return left > right;
  }
  return false;
};

const notificationsDisabled = (environment: UpdateEnvironment): boolean => {
  const ci = variable(environment, "CI");
  return (
    Boolean(variable(environment, "NO_UPDATE_NOTIFIER")) ||
    variable(environment, "npm_config_update_notifier") === "false" ||
    Boolean(ci && ci !== "false")
  );
};

const isPackageName = (name: string): boolean =>
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(
    name,
  );

/** Whether package metadata declares the CLI. */
const providesCli = (metadata: Record<string, unknown>, cli: string) => {
  if (metadata.name === cli) return true;
  const { bin, name } = metadata;
  if (typeof bin === "object" && bin !== null && cli in bin) return true;
  return (
    typeof bin === "string" &&
    typeof name === "string" &&
    name.split("/").pop() === cli
  );
};

/**
 * The npm package of the running entry script, found by walking up from it.
 * Only an installed or checked-out package that provides the CLI qualifies.
 */
const runningPackage = (
  cli: string,
): { readonly name: string; readonly version: string } | undefined => {
  const script = process.argv[1];
  if (!script) return undefined;
  let directory: string;
  try {
    directory = dirname(realpathSync(script));
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        typeof metadata.name === "string" &&
        typeof metadata.version === "string" &&
        providesCli(metadata, cli)
      )
        return { name: metadata.name, version: metadata.version };
    } catch {
      // Not a package directory; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/** The package the notice is about: the running one, with REA's version. */
const updatePackage = (cli: string, version: string) => {
  const running = runningPackage(cli);
  return running === undefined || !isPackageName(running.name)
    ? undefined
    : { name: running.name, current: version };
};

const cacheFile = (
  environment: UpdateEnvironment,
  packageName: string,
): string | undefined => {
  let root = variable(environment, "XDG_CACHE_HOME");
  if (!root) {
    let home = variable(
      environment,
      environment.platform === "win32" ? "USERPROFILE" : "HOME",
    );
    if (home === undefined) {
      try {
        // Match the child without consulting the parent's ambient HOME.
        home = userInfo().homedir;
      } catch {
        // A notice is optional when the OS account has no readable home.
        return undefined;
      }
    }
    root = join(home, ".cache");
  }
  return join(
    root,
    "incur",
    "updates",
    `${encodeURIComponent(packageName)}.json`,
  );
};

const readCache = (file: string): UpdateCache | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof value.checkedAt !== "number") return undefined;
    if (value.latest !== undefined && typeof value.latest !== "string")
      return undefined;
    return value as unknown as UpdateCache;
  } catch {
    return undefined;
  }
};

const writeCache = (file: string, cache: UpdateCache): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache)}\n`);
};

/** Run the refresh in a detached copy of this CLI that outlives the command. */
const scheduleRefresh = (
  file: string,
  checkedAt: number,
  latest: string | undefined,
  environment: UpdateEnvironment,
): void => {
  const script = process.argv[1];
  if (!script) return;
  let selfExecutable = script.startsWith("/$bunfs/");
  try {
    selfExecutable ||= realpathSync(script) === realpathSync(process.execPath);
  } catch {
    // An unresolvable script still runs through the interpreter below.
  }
  const args = selfExecutable
    ? [UPDATE_CHECK_FLAG]
    : [...process.execArgv, script, UPDATE_CHECK_FLAG];
  try {
    writeCache(file, { checkedAt, ...(latest ? { latest } : {}) });
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: environment.variables,
    });
    child.once("error", () => {});
    child.unref();
  } catch {
    // The notice never fails the command it follows.
  }
};

/**
 * A newer cached version, or undefined. Schedules a detached refresh when the
 * cache is missing or older than a day. Callers ask only for terminal output
 * without an explicit format.
 */
export const availableUpdate = (
  cli: string,
  version: string,
  environment: UpdateEnvironment,
): AvailableUpdate | undefined => {
  if (notificationsDisabled(environment)) return undefined;
  const target = updatePackage(cli, version);
  if (target === undefined) return undefined;
  const file = cacheFile(environment, target.name);
  if (file === undefined) return undefined;
  const cached = readCache(file);
  const checkedAt = Date.now();
  if (
    cached === undefined ||
    checkedAt - cached.checkedAt >= REFRESH_INTERVAL_MS
  )
    scheduleRefresh(file, checkedAt, cached?.latest, environment);
  if (!cached?.latest || !isNewerVersion(cached.latest, target.current))
    return undefined;
  return { name: target.name, current: target.current, latest: cached.latest };
};

/** The notice's suggested-command block for an available update. */
export const updateNoticeCta = (cli: string, update: AvailableUpdate) => ({
  description: `Update available for ${update.name}:`,
  commands: [
    {
      command: `${cli} --update`,
      description: `upgrade from ${update.current} to ${update.latest}`,
    },
  ],
});

/** The detached refresh: record the registry's latest version. Never throws. */
export const refreshUpdateCache = async (
  cli: string,
  version: string,
  environment: UpdateEnvironment,
): Promise<void> => {
  try {
    const target = updatePackage(cli, version);
    if (target === undefined) return;
    const file = cacheFile(environment, target.name);
    if (file === undefined) return;
    const registry =
      variable(environment, "npm_config_registry") ||
      "https://registry.npmjs.org";
    const response = await fetch(
      new URL(
        encodeURIComponent(target.name),
        registry.endsWith("/") ? registry : `${registry}/`,
      ),
      {
        headers: {
          accept:
            "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
        },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      },
    );
    if (!response.ok) return;
    const metadata = (await response.json()) as {
      readonly "dist-tags"?: { readonly latest?: unknown };
    };
    const latest = metadata["dist-tags"]?.latest;
    if (typeof latest !== "string" || parseVersion(latest) === undefined)
      return;
    writeCache(file, {
      checkedAt: Date.now(),
      latest,
    });
  } catch {
    // A failed refresh leaves the cache marked checked until the next day.
  }
};
