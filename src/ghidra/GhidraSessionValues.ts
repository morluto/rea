import { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { GHIDRA_BRIDGE_VERSION } from "./GhidraDefaults.js";

const sessionInfoSchema = z
  .object({
    name: z.literal("REA Ghidra bridge"),
    bridge_version: z.literal(GHIDRA_BRIDGE_VERSION),
    run_id: z.string().uuid(),
    profile_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    provider: z
      .object({
        id: z.literal("ghidra"),
        version: z.string().min(1),
      })
      .strict(),
    read_only: z.literal(true),
    analysis_complete: z.boolean(),
    analysis_timed_out: z.boolean(),
    capabilities: z.array(z.enum(["ping", "shutdown"])).max(2),
    target: z
      .object({
        name: z.string().min(1),
        language_id: z.string().min(1),
        compiler_spec_id: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** Authenticated metadata produced after Ghidra finishes auto-analysis. */
export type GhidraSessionInfo = z.infer<typeof sessionInfoSchema>;

/** Require exact run, provider, and profile identity from the Java bridge. */
export const parseGhidraSessionInfo = (
  value: JsonValue,
  expected: {
    readonly runId: string;
    readonly providerVersion: string;
    readonly profileDigest: string;
  },
): Result<GhidraSessionInfo, Error> => {
  const parsed = sessionInfoSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.run_id !== expected.runId ||
    parsed.data.provider.version !== expected.providerVersion ||
    parsed.data.profile_digest !== expected.profileDigest ||
    new Set(parsed.data.capabilities).size !== 2 ||
    !parsed.data.capabilities.includes("ping") ||
    !parsed.data.capabilities.includes("shutdown") ||
    parsed.data.analysis_complete === parsed.data.analysis_timed_out
  )
    return err(new Error("Ghidra bridge handshake identity is invalid"));
  return ok(parsed.data);
};

/** Require acknowledgement that the private bridge loop has ended. */
export const isGhidraShutdownAcknowledgement = (value: JsonValue): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value.shutdown === true &&
  value.project_ephemeral === true;
