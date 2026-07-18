import type { PermissionRequest } from "../domain/permissionPolicy.js";
import type { ProcessScenario } from "../domain/processCapture.js";

/** Build the exact permission request shared by process-capture adapters. */
export const processCapturePermissionRequest = (
  scenario: ProcessScenario,
): PermissionRequest => ({
  capability: "process_capture",
  roots: [scenario.working_directory, ...scenario.filesystem_roots],
  executables: [scenario.executable],
  environment_names: [
    ...Object.keys(scenario.environment),
    ...scenario.inherit_environment,
  ],
  network: scenario.network_access === "host" ? "external" : "none",
  mount: false,
  operation_identity: `capture_process_scenario:${scenario.executable}`,
});
