import { userInfo } from "node:os";

/** Resolve selected home values in precedence order, reading only what is needed. */
export const selectedHomeDirectory = (
  platform: NodeJS.Platform,
  read: (name: string) => string | undefined,
): string | undefined => {
  const nonempty = (name: string): string | undefined => {
    const value = read(name);
    return value === "" ? undefined : value;
  };
  if (platform !== "win32") return nonempty("HOME") ?? nonempty("USERPROFILE");
  const profile = nonempty("USERPROFILE");
  if (profile !== undefined) return profile;
  const drive = nonempty("HOMEDRIVE");
  if (drive !== undefined) {
    const path = nonempty("HOMEPATH");
    if (path !== undefined) return `${drive}${path}`;
  }
  return nonempty("HOME");
};

/** Resolve the caller's selected home before consulting the host account. */
export const homeDirectoryFromEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
  selectedHomeDirectory(platform, (name) => environment[name]) ??
  userInfo().homedir;
