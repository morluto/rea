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

/** Session descriptors in bridge_directory that discovery examined but could not list. */
export type CutterUnlistedDescriptors = {
  /** Descriptor files that could not be read as a bridge session. */
  readonly unreadable: number;
  /** Readable descriptors whose session did not return a valid status. */
  readonly unanswered: number;
};

/**
 * When no session answers, discovery cannot tell why no live session was
 * published, so the limitation lists the possible causes and the observed
 * Cutter 2.5.0 plugin rejection. Descriptors that were published but could not
 * be listed are counted separately.
 */
const NO_LIVE_BRIDGE_LIMITATION =
  "No REA bridge session in bridge_directory answered. Discovery cannot tell whether Cutter is not running, did not load the REA Python plugin, loaded it but could not publish a session (for example, an unwritable or full bridge directory), or uses another REA_CUTTER_BRIDGE_DIR. Cutter's startup log shows whether the plugin loaded; the bridge does not log a publication failure. Official Cutter 2.5.0 builds have been observed to reject Python plugins, including this one (rizinorg/cutter#3659).";

const unlistedLimitations = ({
  unreadable,
  unanswered,
}: CutterUnlistedDescriptors): string[] => [
  ...(unreadable === 0
    ? []
    : [
        `${String(unreadable)} session ${unreadable === 1 ? "descriptor" : "descriptors"} in bridge_directory could not be read (not a private regular file, unreadable, oversized, malformed, or not matching its file name), so ${unreadable === 1 ? "its session is" : "their sessions are"} not listed.`,
      ]),
  ...(unanswered === 0
    ? []
    : [
        `${String(unanswered)} published ${unanswered === 1 ? "session" : "sessions"} in bridge_directory did not return a valid status (stale after Cutter exited, unresponsive, or an incompatible bridge version) and ${unanswered === 1 ? "is" : "are"} not listed.`,
      ]),
];

/**
 * Limitations owned by each discovery status. A found session does not make
 * discovery complete: descriptors that could not be read or whose status probe
 * failed stay unlisted, and their counts remain visible.
 */
export const cutterDiscoveryLimitations = (
  status: z.infer<typeof cutterDiscoverySchema>["discovery_status"],
  unlisted: CutterUnlistedDescriptors = { unreadable: 0, unanswered: 0 },
): string[] => {
  if (status === "no_live_bridge_found")
    return [NO_LIVE_BRIDGE_LIMITATION, ...unlistedLimitations(unlisted)];
  return status === "sessions_found" ? unlistedLimitations(unlisted) : [];
};

export type CutterBridgeSession = z.infer<typeof cutterSessionSchema>;

export type CutterBridgeDiscovery = Readonly<
  Omit<z.infer<typeof cutterDiscoverySchema>, "sessions">
> & {
  readonly sessions: readonly CutterBridgeSession[];
};
