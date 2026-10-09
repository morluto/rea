import { userInfo } from "node:os";

/** Resolve the caller's selected home before consulting the host account. */
export const homeDirectoryFromEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string => {
  const selected =
    platform === "win32"
      ? (environment.USERPROFILE ??
        (environment.HOMEDRIVE !== undefined &&
        environment.HOMEPATH !== undefined
          ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
          : environment.HOME))
      : (environment.HOME ?? environment.USERPROFILE);
  return selected ?? userInfo().homedir;
};
