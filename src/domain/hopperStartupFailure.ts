export type HopperStartupFailureCode =
  | "private_display_unavailable"
  | "x11_authorization_failed"
  | "unsupported_hopper_build"
  | "invalid_launch_command"
  | "process_ownership_mismatch"
  | "hopper_exited_during_startup"
  | "unsupported_demo_dialog"
  | "unexpected_display_geometry"
  | "x11_input_failed"
  | "runtime_dependency_unavailable"
  | "x11_socket_directory_unusable";

export type HopperPrivateDisplayStrategy =
  | "direct"
  | "user-mount-namespace"
  | "unavailable";

/** Bounded, non-secret facts emitted by the Linux private-display adapter. */
export interface HopperStartupDiagnostic {
  readonly schema_version: 1;
  readonly component: "hopper_private_display";
  readonly operation: "probe" | "launch";
  readonly status: "ready" | "error";
  readonly failure_code: HopperStartupFailureCode | null;
  readonly reason: string;
  readonly socket_directory: "/tmp/.X11-unix";
  readonly socket_directory_mode: string | null;
  readonly mount_read_only: boolean | null;
  readonly effective_socket_directory_mode: string | null;
  readonly effective_mount_read_only: boolean | null;
  readonly wsl: boolean;
  readonly strategy: HopperPrivateDisplayStrategy;
  readonly fallback_reason: string | null;
  readonly xvfb_stderr_bytes: number;
  readonly xvfb_stderr_truncated: boolean;
}

const failures = [
  [
    70,
    "private_display_unavailable",
    "REA could not start its private Linux display. Install Xvfb, then rerun rea doctor.",
  ],
  [
    71,
    "x11_authorization_failed",
    "REA could not authorize its private Linux display. Install xauth, then rerun rea doctor.",
  ],
  [
    72,
    "unsupported_hopper_build",
    "This Hopper build is not supported for unattended Linux analysis. Unset HOPPER_LAUNCHER_PATH and rerun rea setup --yes --install-hopper, or update REA.",
  ],
  [
    73,
    "invalid_launch_command",
    "REA refused an unexpected Hopper launch command. Check HOPPER_LAUNCHER_PATH and rerun rea doctor.",
  ],
  [
    74,
    "process_ownership_mismatch",
    "REA could not verify ownership of the launched Hopper process and stopped safely. Close other Hopper sessions and retry.",
  ],
  [
    75,
    "hopper_exited_during_startup",
    "Hopper exited before the REA bridge was ready. Run rea doctor and retry the analysis.",
  ],
  [
    76,
    "unsupported_demo_dialog",
    "This Hopper demo dialog is not supported for unattended Linux analysis. Update REA or use a supported Hopper build.",
  ],
  [
    77,
    "unexpected_display_geometry",
    "REA's private Linux display did not match the validated layout. Close custom display overrides and retry.",
  ],
  [
    78,
    "x11_input_failed",
    "REA could not activate Hopper's validated demo control. Install the XTEST runtime, then rerun rea doctor.",
  ],
  [
    79,
    "runtime_dependency_unavailable",
    "A Linux demo-session dependency is unavailable. Rerun rea setup --yes --install-hopper, then rea doctor.",
  ],
  [
    80,
    "x11_socket_directory_unusable",
    "REA cannot use the host X11 socket directory for a private display. Run rea doctor --provider hopper for exact mount and namespace diagnostics.",
  ],
] as const;

const HOPPER_STARTUP_FAILURES = new Map<
  number,
  { readonly code: HopperStartupFailureCode; readonly message: string }
>(failures.map(([exitCode, code, message]) => [exitCode, { code, message }]));

/** Return the stable public failure associated with a Linux demo adapter exit. */
export const hopperStartupFailure = (exitCode: number | null) =>
  exitCode === null ? undefined : HOPPER_STARTUP_FAILURES.get(exitCode);

/** Return the adapter exit associated with one stable startup failure code. */
export const hopperStartupExitCode = (
  code: HopperStartupFailureCode,
): number | undefined =>
  failures.find(([, candidate]) => candidate === code)?.[0];

/** Narrow an untrusted diagnostic field to the public startup code union. */
export const isHopperStartupFailureCode = (
  value: string,
): value is HopperStartupFailureCode =>
  failures.some(([, candidate]) => candidate === value);
