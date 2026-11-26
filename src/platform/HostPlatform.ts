/**
 * The host this REA process runs on, read once from Node's ambient process
 * facts. This module is the only reader of `process.platform` and
 * `process.arch`: composition takes the host from here, and every other
 * consumer receives the platform (or architecture) as a required parameter.
 *
 * Explicit parameters let one caller describe another host's layout (a
 * Windows client row inspected from macOS, a Linux sandbox's paths) without
 * mixing that choice with the host it actually runs on, and let tests select
 * a platform without redefining global process properties.
 */
export interface HostPlatform {
  /** Node's operating system identifier for this host. */
  readonly platform: NodeJS.Platform;
  /** Node's CPU architecture identifier for this process. */
  readonly architecture: NodeJS.Architecture;
}

/** The running host, captured when this module first loads. */
export const HOST_PLATFORM: HostPlatform = Object.freeze({
  platform: process.platform,
  architecture: process.arch,
});
