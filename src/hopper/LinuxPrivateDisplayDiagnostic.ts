import { z } from "zod";

import {
  isHopperStartupFailureCode,
  type HopperStartupDiagnostic,
} from "../domain/hopperStartupFailure.js";

export const LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX = "REA_X11_DIAGNOSTIC_V1=";

const diagnosticSchema = z
  .object({
    schema_version: z.literal(1),
    component: z.literal("hopper_private_display"),
    operation: z.enum(["probe", "launch"]),
    status: z.enum(["ready", "error"]),
    failure_code: z.string().max(64).nullable(),
    reason: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .max(64),
    socket_directory: z.literal("/tmp/.X11-unix"),
    socket_directory_mode: z
      .string()
      .regex(/^[0-7]{4}$/u)
      .nullable(),
    mount_read_only: z.boolean().nullable(),
    effective_socket_directory_mode: z
      .string()
      .regex(/^[0-7]{4}$/u)
      .nullable(),
    effective_mount_read_only: z.boolean().nullable(),
    wsl: z.boolean(),
    strategy: z.enum(["direct", "user-mount-namespace", "unavailable"]),
    fallback_reason: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .max(64)
      .nullable(),
    xvfb_stderr_bytes: z.number().int().nonnegative().safe(),
    xvfb_stderr_truncated: z.boolean(),
  })
  .strict();

export type LinuxPrivateDisplayDiagnosticParse =
  | { readonly ok: true; readonly value: HopperStartupDiagnostic }
  | {
      readonly ok: false;
      readonly reason:
        | "diagnostic_missing"
        | "diagnostic_multiple"
        | "diagnostic_malformed"
        | "diagnostic_truncated";
    };

/** Parse exactly one bounded, versioned helper diagnostic from stderr. */
export const parseLinuxPrivateDisplayDiagnostic = (
  stderr: string,
  truncated: boolean,
): LinuxPrivateDisplayDiagnosticParse => {
  if (truncated) return { ok: false, reason: "diagnostic_truncated" };
  const records = stderr
    .split("\n")
    .filter((line) => line.startsWith(LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX));
  if (records.length === 0) return { ok: false, reason: "diagnostic_missing" };
  if (records.length !== 1) return { ok: false, reason: "diagnostic_multiple" };
  const record = records[0];
  if (record === undefined) return { ok: false, reason: "diagnostic_missing" };
  try {
    const parsed = diagnosticSchema.safeParse(
      JSON.parse(record.slice(LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX.length)),
    );
    if (!parsed.success) return { ok: false, reason: "diagnostic_malformed" };
    const code = parsed.data.failure_code;
    if (code !== null && !isHopperStartupFailureCode(code))
      return { ok: false, reason: "diagnostic_malformed" };
    if (
      (parsed.data.status === "ready" && code !== null) ||
      (parsed.data.status === "error" && code === null)
    )
      return { ok: false, reason: "diagnostic_malformed" };
    return {
      ok: true,
      value: {
        ...parsed.data,
        failure_code: code,
      },
    };
  } catch {
    return { ok: false, reason: "diagnostic_malformed" };
  }
};
