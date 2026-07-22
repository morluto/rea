import {
  hopperStartupFailure,
  type HopperStartupDiagnostic,
} from "../domain/errors.js";
import type { ProviderProcessDiagnostic } from "../process/ProviderProcess.js";
import { parseLinuxPrivateDisplayDiagnostic } from "./LinuxPrivateDisplayDiagnostic.js";

/** Extract only a matching, versioned Linux adapter failure record. */
export const hopperLauncherFailureDiagnostic = (
  event: Extract<ProviderProcessDiagnostic, { readonly type: "exit" }>,
): HopperStartupDiagnostic | undefined => {
  const parsed = parseLinuxPrivateDisplayDiagnostic(
    event.snapshot.stderr.text,
    event.snapshot.stderr.truncated,
  );
  if (!parsed.ok) return undefined;
  const expected = hopperStartupFailure(event.code)?.code;
  return parsed.value.operation === "launch" &&
    parsed.value.status === "error" &&
    parsed.value.failure_code === expected
    ? parsed.value
    : undefined;
};
