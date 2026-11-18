import type { Result } from "../domain/result.js";

/** Why the verification owner refused to authenticate a Linux launcher. */
export interface LinuxHopperLauncherRejection extends Error {
  /** Parsed failure reason; `cancelled` when the caller's signal stopped it. */
  readonly reason: string;
}

/**
 * Read-only authentication of a Linux Hopper launcher before REA runs it.
 * Hopper setup (src/application/LinuxHopper.ts) implements it; production
 * composition supplies it to the Hopper provider.
 */
export interface LinuxHopperLauncherVerification {
  /** Authenticate the launcher and report the launcher bytes it verified. */
  readonly inspect: (
    path: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal?: AbortSignal,
  ) => Promise<
    Result<{ readonly sha256: string }, LinuxHopperLauncherRejection>
  >;
  /** Retry cleanup the verification owner retained after a failed close. */
  readonly retryCleanup: () => Promise<void>;
}
