import { z } from "zod";

/** Observed Cutter session identity without bridge transport credentials. */
export const cutterSessionSchema = z.strictObject({
  session_id: z.string().uuid(),
  pid: z.int().positive(),
  document_generation: z.int().nonnegative(),
  current_file: z.string().nullable(),
  cutter_version: z.string().nullable(),
  identity_status: z.literal("partial"),
});

/** Discovery facts retained independently of descriptor cleanup. */
export const cutterDiscoverySchema = z.strictObject({
  sessions: z.array(cutterSessionSchema),
  bridge_directory: z.string(),
  discovery_status: z.enum([
    "sessions_found",
    "no_live_bridge_found",
    "bridge_directory_unavailable",
    "bridge_directory_insecure",
    "bridge_directory_capacity_exceeded",
  ]),
  bridge_directory_security: z.enum([
    "private_verified",
    "not_private",
    "unverified_platform_acl",
    "not_checked",
  ]),
  /** What this discovery status cannot establish. */
  limitations: z.array(z.string()),
});

/**
 * An unanswered discovery cannot name its cause, so the limitation lists the
 * possible ones: nothing published, or a published session whose status probe
 * failed, including the observed Cutter 2.5.0 plugin rejection.
 */
const NO_LIVE_BRIDGE_LIMITATION =
  "No REA bridge session in bridge_directory answered. Discovery cannot tell whether Cutter is not running, did not load the REA Python plugin, uses another REA_CUTTER_BRIDGE_DIR, or published a session that did not return a valid status (stale after Cutter exited, unresponsive, or an incompatible bridge version); Cutter's startup log shows whether the plugin loaded. Official Cutter 2.5.0 builds have been observed to reject Python plugins, including this one (rizinorg/cutter#3659).";

/**
 * Limitations owned by each discovery status. A found session does not make
 * discovery complete: published sessions whose status probe failed stay
 * unlisted, and their count remains visible.
 */
export const cutterDiscoveryLimitations = (
  status: z.infer<typeof cutterDiscoverySchema>["discovery_status"],
  unansweredSessions = 0,
): string[] => {
  if (status === "no_live_bridge_found") return [NO_LIVE_BRIDGE_LIMITATION];
  if (status !== "sessions_found" || unansweredSessions === 0) return [];
  const sessions = unansweredSessions === 1 ? "session" : "sessions";
  return [
    `${String(unansweredSessions)} other published ${sessions} in bridge_directory did not return a valid status (stale after Cutter exited, unresponsive, or an incompatible bridge version) and ${unansweredSessions === 1 ? "is" : "are"} not listed.`,
  ];
};

export type CutterBridgeSession = z.infer<typeof cutterSessionSchema>;

export type CutterBridgeDiscovery = Readonly<
  Omit<z.infer<typeof cutterDiscoverySchema>, "sessions">
> & {
  readonly sessions: readonly CutterBridgeSession[];
};
