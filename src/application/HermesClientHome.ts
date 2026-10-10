import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/** An unresolved Hermes profile must not be configured as the default home. */
export class HermesClientPathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "HermesClientPathError";
  }
}

const defaultDirectory = (
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): string => {
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  return platform === "win32"
    ? join(
        env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"),
        `hermes${suffix}`,
      )
    : join(home, `.hermes${suffix}`);
};
const expandedDirectory = (
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): string | undefined => {
  const override = env.HERMES_HOME?.trim();
  if (!override) return undefined;
  const variables = override.replace(
    /\$(\w+|\{[^}]*\})/gu,
    (match, variable: string) => {
      const key = variable.startsWith("{") ? variable.slice(1, -1) : variable;
      return env[key] ?? match;
    },
  );
  const expanded =
    platform === "win32"
      ? variables.replace(
          /%([^%]+)%/gu,
          (match, variable: string) => env[variable] ?? match,
        )
      : variables;
  if (expanded === "~") return home;
  if (
    expanded.startsWith("~/") ||
    (platform === "win32" && expanded.startsWith("~\\"))
  )
    return join(home, expanded.slice(2));
  return resolve(expanded);
};
const physicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const within = (root: string, path: string): boolean => {
  const difference = relative(physicalPath(root), physicalPath(path));
  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
};
const PROFILE_MARKERS = [
  "config.yaml",
  ".env",
  "SOUL.md",
  "profile.yaml",
  "auth.json",
  "state.db",
];
const RESERVED_PROFILES = new Set(["hermes", "test", "tmp", "root", "sudo"]);
const liveProfile = (path: string): boolean => {
  try {
    if (!statSync(path).isDirectory()) return false;
    try {
      statSync(join(dirname(path), ".deleted", basename(path)));
      return false;
    } catch {
      /* No tombstone. */
    }
    return PROFILE_MARKERS.some((marker) => {
      try {
        const status = lstatSync(join(path, marker));
        return status.isFile() || status.isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

/** Match Hermes CLI sticky-profile selection while retaining the configured path spelling. */
export const resolveHermesClientHome = (
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): string => {
  const native = defaultDirectory(home, platform, env);
  const root = expandedDirectory(home, platform, env) ?? native;
  // An explicit named profile bypasses the root's sticky selection in Hermes CLI.
  if (basename(dirname(root)) === "profiles") return root;
  const stickyRoot = within(native, root) ? native : root;
  let name: string;
  try {
    // Python uses utf-8-sig and ignores unreadable / invalid-UTF8 active_profile files.
    name = new TextDecoder("utf-8", { fatal: true })
      .decode(readFileSync(join(stickyRoot, "active_profile")))
      .trim();
  } catch {
    return root;
  }
  if (name === "" || name === "default") return root;
  const canonical = name.toLowerCase();
  if (canonical === "default") return root;
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(canonical) ||
    RESERVED_PROFILES.has(canonical)
  )
    throw new HermesClientPathError(
      join(stickyRoot, "active_profile"),
      `Invalid saved Hermes profile ${JSON.stringify(name)}. Run 'hermes profile use default' or repair active_profile.`,
    );
  const selected = join(root, "profiles", canonical);
  if (!liveProfile(selected))
    throw new HermesClientPathError(
      selected,
      `Saved Hermes profile ${JSON.stringify(name)} is missing, deleted, or has no profile identity. Run 'hermes profile use default' or restore that profile before configuring it.`,
    );
  return selected;
};
