import type { HostPlatform } from "../../src/platform/HostPlatform.js";

/**
 * The only host the pwntools decoders and the EVM interface worker admit.
 * Tests pass it to a provider to exercise admission, launch and cleanup on any
 * POSIX host; process ownership, fixture launches and the filesystem stay
 * those of the real host.
 */
export const SIMULATED_LINUX_X64: HostPlatform = Object.freeze({
  platform: "linux",
  architecture: "x64",
});
