import { describe, expect, it } from "vitest";

import { processScenarioSchema } from "./processScenario.js";

describe("direct process scenarios", () => {
  it("defaults to one command with inherited environment and no filesystem scan", () => {
    expect(processScenarioSchema.parse({ executable: "node" })).toMatchObject({
      executable: "node",
      arguments: [],
      working_directory: ".",
      environment: {},
      filesystem_observation_paths: [],
      events: [],
    });
  });

  it("accepts caller-selected environment and explicit filesystem observations", () => {
    const environment = { "app.setting": "value", "1": "numbered" };
    const scenario = processScenarioSchema.parse({
      executable: "node",
      arguments: ["./task.mjs"],
      working_directory: "./project",
      environment,
      filesystem_observation_paths: ["state"],
    });
    expect(scenario.environment).toEqual(environment);
    expect(scenario.filesystem_observation_paths).toEqual(["state"]);
  });

  it("rejects malformed environment names and adapter-reserved identity", () => {
    for (const name of ["", "KEY=VALUE", "KEY\0VALUE", "REA_PROCESS_RUN_ID"]) {
      const result = processScenarioSchema.safeParse({
        executable: "node",
        environment: { [name]: "value" },
      });
      expect(result.success).toBe(false);
      if (name === "" && !result.success) {
        const invalidKey = result.error.issues[0];
        expect(invalidKey?.code).toBe("invalid_key");
        if (invalidKey?.code === "invalid_key") {
          expect(invalidKey.issues[0]?.message).toBe(
            "Environment names must not be empty",
          );
        }
      }
      if (name === "REA_PROCESS_RUN_ID" && !result.success) {
        const invalidKey = result.error.issues[0];
        expect(invalidKey?.code).toBe("invalid_key");
        if (invalidKey?.code === "invalid_key") {
          expect(invalidKey.issues[0]?.message).toBe(
            "REA_PROCESS_RUN_ID is reserved by the process adapter",
          );
        }
      }
    }
    expect(
      processScenarioSchema.safeParse({
        executable: "node",
        environment: { "REA_PROCESS_RUN_ID\n": "caller-value" },
      }).success,
    ).toBe(true);
  });

  it("keeps bounded capture controls and ordered scheduled interaction", () => {
    const scenario = processScenarioSchema.parse({
      executable: "node",
      events: [
        { type: "input", at_ms: 10, data: "answer", sensitive: true },
        { type: "resize", at_ms: 20, columns: 100, rows: 30 },
        { type: "signal", at_ms: 30, signal: "SIGTERM" },
      ],
      limits: { output_bytes: 2_000_000, filesystem_depth: 0 },
    });
    expect(scenario.events).toHaveLength(3);
    expect(scenario.events[0]).toMatchObject({ sensitive: true });
    expect(scenario.limits.output_bytes).toBe(2_000_000);
    expect(scenario.limits.filesystem_depth).toBe(0);
  });

  it("rejects events after timeout and unknown orchestration fields", () => {
    expect(
      processScenarioSchema.safeParse({
        executable: "node",
        timeout_ms: 10,
        events: [{ type: "input", at_ms: 11, data: "late" }],
      }).success,
    ).toBe(false);
    for (const [field, value] of [
      ["command_shims", []],
      ["replay", {}],
      ["reactive", {}],
      ["checkpoints", []],
    ] as const)
      expect(
        processScenarioSchema.safeParse({ executable: "node", [field]: value })
          .success,
      ).toBe(false);
  });
});
