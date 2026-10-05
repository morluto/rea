/** Return whether this host has the platform boundary required by replay v1. */
export const isSupportedControlledReplayHost = (
  platform: string,
  architecture: string,
): boolean => platform === "linux" && architecture === "x64";
