import { describe, expect, it } from "vitest";

import { processCapturePermissionRequest } from "../src/application/ProcessCapturePermission.js";
import { parseProcessScenario } from "../src/domain/processCapture.js";

describe("process capture permission request", () => {
  it("projects the complete adapter-neutral authority scope", () => {
    const scenario = parseProcessScenario({
      approved: true,
      executable: "/bin/tool",
      arguments: ["--probe"],
      working_directory: "/workspace",
      environment: { FIXTURE_TOKEN: "secret" },
      inherit_environment: ["PATH"],
      filesystem_roots: ["/workspace/output"],
      network_access: "host",
      events: [],
    });

    expect(processCapturePermissionRequest(scenario)).toEqual({
      capability: "process_capture",
      roots: ["/workspace", "/workspace/output"],
      executables: ["/bin/tool"],
      environment_names: ["FIXTURE_TOKEN", "PATH"],
      network: "external",
      mount: false,
      operation_identity: "capture_process_scenario:/bin/tool",
    });
  });
});
