import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { IdaSessionClient } from "../../../src/ida/IdaSessionClient.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createIdaTarget, RecordingIdaMcp } from "../../fixtures/idaMcp.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

it.each([2, 3])(
  "preserves unknown IDA readiness at owner health check %s",
  async (failureCheck) => {
    const { root, target } = await createIdaTarget("arm64");
    const producer = new RecordingIdaMcp(target, "headless");
    let xrefsSeen = false;
    let healthAfterXrefs = 0;
    producer.overrideCall = (name) => {
      if (name === "xrefs_to") xrefsSeen = true;
      if (
        name === "server_health" &&
        xrefsSeen &&
        ++healthAfterXrefs >= failureCheck
      )
        return {
          status: "ok",
          input_path: producer.inputPath,
          idb_path: `${producer.inputPath}.i64`,
          module: "target.elf",
          imagebase: producer.imageBase,
          auto_analysis_ready: null,
        };
      return undefined;
    };
    const ida = new IdaSessionClient(
      {
        command: "fixture",
        args: [],
        env: {},
        mode: "headless",
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    const mcp = await connect(ida);
    try {
      const result = await mcp.callTool({
        name: "trace_feature",
        arguments: { query: "a.b" },
      });
      const error = parseMcpToolError(result).error;
      expect(error).toMatchObject({
        code: "capability_unavailable",
        details: {
          operation: "server_health",
          diagnostics: { auto_analysis_ready: null },
        },
      });
      expect(error.remediation?.action).toContain(
        "Inspect the upstream IDA worker",
      );
      expect(healthAfterXrefs).toBe(failureCheck);
      if (failureCheck === 3) {
        expect(error.details?.partial_observation).toMatchObject({
          operation: "resolve_containing_procedure",
          provider: { id: "ida" },
        });
      }
    } finally {
      expect((await ida.close()).ok).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
