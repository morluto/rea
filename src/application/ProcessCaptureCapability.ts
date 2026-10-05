import { tmpdir } from "node:os";

export type ProcessCaptureCapability =
  | { readonly available: true; readonly backend: "node-pty" }
  | {
      readonly available: false;
      readonly backend: "node-pty";
      readonly reason: string;
    };

/** Explain why process capture cannot claim owned-process cleanup on a host. */
export const processCaptureOwnershipUnavailableReason = (
  platform: NodeJS.Platform,
): string | undefined =>
  platform === "win32"
    ? "Windows process-tree ownership and cleanup are unavailable; REA cannot verify that descendants have stopped."
    : undefined;

/** Probe the actual native PTY seam instead of inferring support from the OS name. */
export const probeProcessCaptureCapability =
  async (): Promise<ProcessCaptureCapability> => {
    const ownershipReason = processCaptureOwnershipUnavailableReason(
      process.platform,
    );
    if (ownershipReason !== undefined)
      return {
        available: false,
        backend: "node-pty",
        reason: ownershipReason,
      };
    try {
      const { spawn } = await import("@lydell/node-pty");
      const terminal = spawn(
        process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        process.platform === "win32" ? ["/c", "exit", "0"] : ["-c", "exit 0"],
        {
          cwd: tmpdir(),
          env: { HOME: tmpdir(), TERM: "xterm-256color" },
          cols: 80,
          rows: 24,
          name: "xterm-256color",
        },
      );
      await new Promise<void>((resolveExit) =>
        terminal.onExit(() => resolveExit()),
      );
      return { available: true, backend: "node-pty" };
    } catch {
      return {
        available: false,
        backend: "node-pty",
        reason: "the native PTY backend could not start a probe process",
      };
    }
  };
