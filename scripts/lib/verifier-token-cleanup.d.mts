import type {
  ProcessCleanupResult,
  ProcessOwnershipHost,
} from "../../src/process/ProcessOwnership.js";
import type { VerifierRunStart } from "./verifier-run.mjs";

/** Capture the prelaunch identities used by the canonical, PPID-independent sweep. */
export function prepareVerifierTokenCleanup(
  run: VerifierRunStart,
  suppliedHost?: ProcessOwnershipHost,
): Promise<{
  verify(): Promise<ProcessCleanupResult>;
  close(): Promise<void>;
}>;
