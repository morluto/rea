import { isAbsolute, posix, win32 } from "node:path";
import {
  homeDirectoryFromEnvironment,
  selectedHomeDirectorySettings,
} from "../config/homeDirectory.js";
import { absoluteCallerPath, appendCallerPath } from "./callerPath.js";

const selectedXdgCacheRoot = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform === "darwin") return undefined;
  const xdg = environment.XDG_CACHE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : undefined;
};

/** Settings consulted when selecting the default cache location. */
export const reaCacheLocationSettings = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] => [
  ...(platform === "darwin" ? [] : ["XDG_CACHE_HOME"]),
  ...(selectedXdgCacheRoot(environment, platform) === undefined
    ? selectedHomeDirectorySettings(platform, environment)
    : []),
];

/** Per-user cache directory that REA owns for Kuna on this host. */
export const defaultKunaCacheDirectory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  home?: string,
): string => reaCacheDirectory(environment, platform, "kuna", home);

/** A per-user cache directory REA owns on this host: `rea/<name>` under the platform's cache root. */
export const reaCacheDirectory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  name: string,
  home?: string,
): string => {
  const root =
    selectedXdgCacheRoot(environment, platform) ??
    appendCallerPath(
      home ?? homeDirectoryFromEnvironment(environment, platform),
      platform === "darwin" ? "Library/Caches" : ".cache",
      platform,
    );
  return appendCallerPath(root, `rea/${name}`, platform);
};

/**
 * Lexical directory identity. Keeps POSIX parent traversal distinct because
 * collapsing it can change directory identity across symbolic links.
 * On Darwin and Linux, `\` is a filename character, so only `/` is removed.
 */
export const sameLexicalDirectory = (
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean =>
  lexicalDirectory(left, platform) === lexicalDirectory(right, platform);

/**
 * True when `child` is `parent` or is spelled below it. Parent traversal is
 * never collapsed, because after a symbolic link it leads somewhere else:
 * callers resolve such spellings through the filesystem instead.
 */
export const withinLexicalDirectory = (
  child: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean => {
  const base = lexicalDirectory(parent, platform);
  const inner = lexicalDirectory(child, platform);
  const separator = (platform === "win32" ? win32 : posix).sep;
  return (
    inner === base ||
    inner.startsWith(base.endsWith(separator) ? base : base + separator)
  );
};

/** True when a POSIX spelling contains a `..` segment, whose meaning only the filesystem knows. */
export const hasParentTraversal = (value: string): boolean =>
  value.split("/").includes("..");

const lexicalDirectory = (value: string, platform: NodeJS.Platform): string => {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = absoluteCallerPath(value, { platform });
  const root = pathApi.parse(normalized).root;
  let end = normalized.length;
  while (
    end > root.length &&
    normalized.charCodeAt(end - 1) === pathApi.sep.charCodeAt(0)
  )
    end -= 1;
  return normalized.slice(0, end);
};
