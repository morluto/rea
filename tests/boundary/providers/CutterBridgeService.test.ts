import { expect, it } from "vitest";

import { CutterBridgeService } from "../../../src/cutter/CutterBridgeService.js";

it("retains uncertain command completion as Evidence without encouraging a retry", async () => {
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    execute: async () => ({
      output: null,
      currentFile: "/fixtures/sample.bin",
      documentGeneration: 7,
      identityStatus: "partial",
      cutterVersion: "Cutter fixture version",
      executionState: "unknown",
      error: "transport-response-missing",
      message: "The command may have completed; do not retry automatically",
      outputTruncated: false,
    }),
  });

  const result = await service.execute({
    session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
    expected_generation: 7,
    command: "Ps /tmp/project.rzdb",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    command: "Ps /tmp/project.rzdb",
    output: null,
    execution_state: "unknown",
    error: "transport-response-missing",
    message: expect.stringContaining("do not retry automatically"),
    document_generation: 7,
    cutter_version: "Cutter fixture version",
  });
  expect(result.value.limitations).toContain(
    "Command completion or its output could not be confirmed; do not retry automatically because the command may have produced partial or persistent effects.",
  );
  expect(result.value.provider.version).toBe("Cutter fixture version");
});
