import {
  hopperStartupFailure,
  type HopperStartupFailureDiagnostic,
} from "../domain/hopperStartupFailure.js";
import type { ProviderProcessDiagnostic } from "../process/ProviderProcess.js";
import { parseLinuxPrivateDisplayDiagnostic } from "./LinuxPrivateDisplayDiagnostic.js";

/** Extract only a matching Linux adapter failure record. */
export const hopperLauncherFailureDiagnostic = (
  event: Extract<ProviderProcessDiagnostic, { readonly type: "exit" }>,
): HopperStartupFailureDiagnostic | undefined => {
  const parsed = parseLinuxPrivateDisplayDiagnostic(event.snapshot.stderr.text);
  if (!parsed.ok) return undefined;
  const expected = hopperStartupFailure(event.code)?.code;
  return parsed.value.operation === "launch" &&
    parsed.value.status === "error" &&
    parsed.value.failure_code === expected
    ? parsed.value
    : undefined;
};
