import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { appendCallerPath } from "../filesystem/callerPath.js";

// Pin the POSIX v2 generator instead of trusting its uninstall marker.
// https://github.com/aubepkg/aube/blob/d4c6265856caea19c7e8699d289ccc6773de02bd/crates/aube-linker/src/sys.rs#L1063-L1154
const MAX_BIN_SHIM_BYTES = 64 * 1024;
const TARGET_MARKER = "# aube-bin-shim v2 target=";
const BOUND_NODE_MARKER = "# aube-node-shim v1 ";
const SAFE_TARGET = /^[\w.@+/-]+$/u;
const SAFE_NODE_PATH =
  /^export NODE_PATH="\$basedir\/[\w.@+/-]+(?::\$basedir\/[\w.@+/-]+)*"$/u;
const AUBE_POSIX_LINK_HOPS = 40;
const BASEDIR = [
  'link="$0"',
  "hops=0",
  `while [ -L "$link" ] && [ "$hops" -lt ${AUBE_POSIX_LINK_HOPS} ]; do`,
  "  hops=$((hops+1))",
  '  target=$(readlink "$link")',
  '  case "$target" in',
  '    /*) link="$target" ;;',
  '    *)  link="$(dirname "$link")/$target" ;;',
  "  esac",
  "done",
  'basedir=$(dirname "$link")',
];

const SHIM_SHELL = "/bin/sh";
const SHIM_HELPERS = [
  'dirname() { if [ -x /usr/bin/dirname ]; then /usr/bin/dirname "$@"; else /bin/dirname "$@"; fi; }',
  'readlink() { if [ -x /usr/bin/readlink ]; then /usr/bin/readlink "$@"; else /bin/readlink "$@"; fi; }',
];
const SHIM_WITH_NODE = [
  ...SHIM_HELPERS,
  'rea_node="$1"',
  "shift",
  // Intercept the generated fallback command and keep the client's PATH.
  // POSIX exec looks up external commands without consulting shell functions.
  'rea_exec() { if [ "$1" = node ]; then shift; command exec "$rea_node" "$@"; fi; command exec "$@"; }',
  "alias exec=rea_exec",
  '. "$0"',
].join("\n");

export interface AubeShimLauncher {
  readonly shim: string;
  readonly fallbackRuntime: string;
}

export const aubeShimRegistration = ({
  shim,
  fallbackRuntime,
}: AubeShimLauncher): readonly string[] => [
  SHIM_SHELL,
  "-c",
  SHIM_WITH_NODE,
  shim,
  fallbackRuntime,
  "mcp",
];

export const registeredAubeShim = (
  command: readonly string[],
): AubeShimLauncher | undefined => {
  const [, , body, shim, argument, last] = command;
  if (command[0] !== SHIM_SHELL || command[1] !== "-c" || shim === undefined)
    return undefined;
  if (
    command.length === 6 &&
    body === SHIM_WITH_NODE &&
    argument !== undefined &&
    isAbsolute(argument) &&
    last === "mcp"
  )
    return { shim, fallbackRuntime: argument };
  return undefined;
};

/** The shell walks symlinks at the supplied name without canonicalizing its parent. */
const shellShimPath = (path: string): string => {
  let link = path;
  for (let hops = 0; lstatSync(link).isSymbolicLink(); hops += 1) {
    if (hops === AUBE_POSIX_LINK_HOPS)
      throw new Error("Aube shim exceeded its symbolic link traversal limit");
    const target = readlinkSync(link);
    link = isAbsolute(target)
      ? target
      : appendCallerPath(dirname(link), target);
  }
  return link;
};

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const shellHelpersAvailable = (): boolean =>
  ["dirname", "readlink"].every((name) =>
    [`/usr/bin/${name}`, `/bin/${name}`].some(executable),
  );

const readShim = (path: string): string | undefined => {
  try {
    accessSync(path, constants.X_OK);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BIN_SHIM_BYTES) return undefined;
    const contents = readFileSync(path, {
      flag: constants.O_RDONLY | constants.O_NONBLOCK,
    });
    return contents.length <= MAX_BIN_SHIM_BYTES
      ? contents.toString("utf8")
      : undefined;
  } catch {
    return undefined;
  }
};

const sameFile = (left: string, right: string): boolean => {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
};

/** The script launched by a supported Aube Node shim with its recorded binding. */
export const aubeShimTarget = (
  shim: string,
  runtime: string,
  fallbackRuntime?: string,
): string | undefined => {
  if (!isAbsolute(shim)) return undefined;
  const lines = readShim(shim)?.split("\n");
  if (lines?.shift() !== "#!/bin/sh") return undefined;
  const marker = lines.shift();
  if (!marker?.startsWith(TARGET_MARKER)) return undefined;
  const target = marker.slice(TARGET_MARKER.length);
  if (!SAFE_TARGET.test(target) || isAbsolute(target)) return undefined;
  const bound = lines[0]?.startsWith(BOUND_NODE_MARKER) === true;
  if (
    bound &&
    !/^[a-f0-9]+$/u.test(lines.shift()!.slice(BOUND_NODE_MARKER.length))
  )
    return undefined;
  if (!BASEDIR.every((line) => line.trimStart() === lines.shift()?.trimStart()))
    return undefined;
  if (lines[0] !== undefined && SAFE_NODE_PATH.test(lines[0])) lines.shift();

  try {
    const parent = dirname(shellShimPath(shim));
    const selectedRuntime = realpathSync.native(runtime);
    if (bound) {
      const exec = /^exec '([^'\n]+)' "\$basedir\/"'([^'\n]+)' "\$@"$/u.exec(
        lines[0] ?? "",
      );
      const interpreter = exec?.[1];
      if (
        lines.length !== 2 ||
        lines[1] !== "" ||
        interpreter === undefined ||
        interpreter !== selectedRuntime ||
        exec?.[2] !== target
      )
        return undefined;
      accessSync(interpreter, constants.X_OK);
    } else {
      const body = [
        'if [ -x "$basedir/node" ]; then',
        ` exec "$basedir/node" "$basedir/${target}" "$@"`,
        "else",
        ` exec node "$basedir/${target}" "$@"`,
        "fi",
        "",
      ];
      if (
        lines.length !== body.length ||
        !body.every(
          (line, index) => line.trimStart() === lines[index]?.trimStart(),
        )
      )
        return undefined;
      // The shell resolves a Node executable with native traversal. Only the
      // script argument is later normalized by Node itself.
      const localRuntime = appendCallerPath(parent, "node");
      const interpreter = executable(localRuntime)
        ? localRuntime
        : fallbackRuntime;
      if (
        interpreter === undefined ||
        !executable(interpreter) ||
        realpathSync.native(interpreter) !== selectedRuntime
      )
        return undefined;
    }
    return resolve(parent, target);
  } catch {
    return undefined;
  }
};

/** The outer generated shim that selects the running installation's script. */
export const aubeShimLauncher = (
  entrypoint: string,
  name: string,
  installedRuntime: string,
): AubeShimLauncher | undefined => {
  if (!isAbsolute(entrypoint) || !shellHelpersAvailable()) return undefined;
  let launcher: AubeShimLauncher | undefined;
  for (
    let directory = dirname(entrypoint);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "node_modules") continue;
    const candidate = join(directory, ".bin", name);
    const target = aubeShimTarget(
      candidate,
      installedRuntime,
      installedRuntime,
    );
    // The fallback must survive independently of the shim's sibling Node.
    if (target !== undefined && sameFile(target, entrypoint))
      launcher = { shim: candidate, fallbackRuntime: installedRuntime };
  }
  return launcher;
};
