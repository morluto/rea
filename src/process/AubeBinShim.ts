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
type AubeNodeBinding = "shim" | "saved";

const shimWrapper = (exec: string): string =>
  [
    ...SHIM_HELPERS,
    'rea_node="$1"',
    "shift",
    exec,
    "alias exec=rea_exec",
    '. "$0"',
  ].join("\n");

const SHIM_WRAPPERS = {
  // Preserve the saved unbound wrapper and its sibling-first behavior.
  shim: shimWrapper(
    'rea_exec() { if [ "$1" = node ]; then shift; command exec "$rea_node" "$@"; fi; command exec "$@"; }',
  ),
  // The verified bound template has one exec, whose arguments select the script.
  saved: shimWrapper('rea_exec() { shift; command exec "$rea_node" "$@"; }'),
} satisfies Record<AubeNodeBinding, string>;

export interface AubeShimLauncher {
  readonly shim: string;
  readonly fallbackRuntime: string;
  readonly nodeBinding: AubeNodeBinding;
}

export const aubeShimRegistration = ({
  shim,
  fallbackRuntime,
  nodeBinding,
}: AubeShimLauncher): readonly string[] => [
  SHIM_SHELL,
  "-c",
  SHIM_WRAPPERS[nodeBinding],
  shim,
  fallbackRuntime,
  "mcp",
];

export const registeredAubeShim = (
  command: readonly string[],
): AubeShimLauncher | undefined => {
  const [, , body, shim, argument, last] = command;
  if (
    command.length !== 6 ||
    command[0] !== SHIM_SHELL ||
    command[1] !== "-c" ||
    shim === undefined ||
    argument === undefined ||
    !isAbsolute(argument) ||
    last !== "mcp"
  )
    return undefined;
  if (body === SHIM_WRAPPERS.shim)
    return { shim, fallbackRuntime: argument, nodeBinding: "shim" };
  if (body === SHIM_WRAPPERS.saved)
    return { shim, fallbackRuntime: argument, nodeBinding: "saved" };
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

interface AubeShimFacts {
  readonly target: string;
  /** The sibling slot, before any symlink at that file is followed. */
  readonly siblingRuntime: string;
  /** Present only for a verified host-bound template. */
  readonly boundRuntime?: string;
}

/** Interpret the supported shell templates once and retain their interpreter facts. */
const readAubeShim = (shim: string): AubeShimFacts | undefined => {
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

  let boundRuntime: string | undefined;
  if (bound) {
    const exec = /^exec '([^'\n]+)' "\$basedir\/"'([^'\n]+)' "\$@"$/u.exec(
      lines[0] ?? "",
    );
    boundRuntime = exec?.[1];
    if (
      lines.length !== 2 ||
      lines[1] !== "" ||
      boundRuntime === undefined ||
      !isAbsolute(boundRuntime) ||
      exec?.[2] !== target
    )
      return undefined;
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
  }

  try {
    const parent = dirname(shellShimPath(shim));
    return {
      // Node normalizes the script argument, while the shell selects Node natively.
      target: resolve(parent, target),
      siblingRuntime: appendCallerPath(realpathSync.native(parent), "node"),
      ...(boundRuntime === undefined ? {} : { boundRuntime }),
    };
  } catch {
    return undefined;
  }
};

const runtimeMatches = (path: string | undefined, runtime: string): boolean =>
  path !== undefined && executable(path) && sameFile(path, runtime);

const shimRuntime = (
  { boundRuntime, siblingRuntime }: AubeShimFacts,
  fallbackRuntime: string | undefined,
): string | undefined =>
  boundRuntime ??
  (executable(siblingRuntime) ? siblingRuntime : fallbackRuntime);

interface AubeShimInspection {
  readonly target: string;
  readonly siblingRuntime: string;
  readonly fallbackApplies: boolean;
}

/** Verify the interpreter selected by the saved wrapper, or by the direct shim. */
export const inspectAubeShim = (
  shim: string,
  runtime: string,
  fallbackRuntime?: string,
  nodeBinding: AubeNodeBinding = "shim",
): AubeShimInspection | undefined => {
  const facts = readAubeShim(shim);
  if (facts === undefined) return undefined;
  const interpreter =
    nodeBinding === "saved"
      ? fallbackRuntime
      : shimRuntime(facts, fallbackRuntime);
  if (!runtimeMatches(interpreter, runtime)) return undefined;
  return {
    target: facts.target,
    siblingRuntime: facts.siblingRuntime,
    fallbackApplies:
      nodeBinding === "saved" || facts.boundRuntime === undefined,
  };
};

/** A still-installed host binding must agree with the runtime selected for setup. */
const compatibleBoundRuntime = (bound: string, runtime: string): boolean => {
  try {
    statSync(bound);
  } catch (cause) {
    // The recognized wrapper can use the selected runtime after the bound Node is removed.
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
  }
  return runtimeMatches(bound, runtime);
};

interface AubeShimLocation {
  readonly shim: string;
  readonly siblingRuntime: string;
  readonly nodeBinding: AubeNodeBinding;
}

/** The outer generated shim that selects the running installation's script. */
export const aubeShimLauncher = (
  entrypoint: string,
  name: string,
  installedRuntime: string,
): AubeShimLocation | undefined => {
  if (!isAbsolute(entrypoint) || !shellHelpersAvailable()) return undefined;
  let launcher: AubeShimLocation | undefined;
  for (
    let directory = dirname(entrypoint);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "node_modules") continue;
    const shim = join(directory, ".bin", name);
    const facts = readAubeShim(shim);
    if (facts === undefined || !sameFile(facts.target, entrypoint)) continue;
    const { boundRuntime, siblingRuntime } = facts;
    const compatible =
      boundRuntime === undefined
        ? runtimeMatches(shimRuntime(facts, installedRuntime), installedRuntime)
        : compatibleBoundRuntime(boundRuntime, installedRuntime);
    if (compatible)
      launcher = {
        shim,
        siblingRuntime,
        nodeBinding: boundRuntime === undefined ? "shim" : "saved",
      };
  }
  return launcher;
};
