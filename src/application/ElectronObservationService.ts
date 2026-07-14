import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import type { Evidence } from "../domain/evidence.js";
import type {
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../domain/electronObservation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { createElectronEvidence } from "./ElectronEvidence.js";

/** Authorize and list root-confined Electron page targets. */
export const listElectronTargets = async (
  provider: ElectronObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListElectronTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    provider,
    authority,
    input,
    "list_electron_targets",
  );
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? ok(
        createElectronEvidence(
          "list_electron_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Authorize and inspect one root-confined Electron page. */
export const inspectElectronPage = async (
  provider: ElectronObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: InspectElectronPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    provider,
    authority,
    input,
    "inspect_electron_page",
  );
  if (!ready.ok) return ready;
  const result = await ready.value.inspectPage(input, options);
  return result.ok
    ? ok(
        createElectronEvidence(
          "inspect_electron_page",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

const prepare = async (
  provider: ElectronObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListElectronTargetsInput | InspectElectronPageInput,
  operation: "list_electron_targets" | "inspect_electron_page",
): Promise<Result<ElectronObservationPort, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-cdp-electron",
        operation,
        "Electron observation permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "electron_observe",
      roots: input.allowed_file_roots,
      executables: [],
      environment_names: [],
      origins: [input.cdp_endpoint],
      network: "loopback",
      mount: false,
      operation_identity: `${operation}:${"target_id" in input ? input.target_id : input.cdp_endpoint}`,
    },
    "read",
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  return provider === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-electron",
          operation,
          "Electron observation provider is not configured",
        ),
      )
    : ok(provider);
};
