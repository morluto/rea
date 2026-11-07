import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { nativeUiObservationInputSchema } from "../../../src/domain/native/nativeUiObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import type { TestCli } from "../../support/cli/cliFixture.js";

const runCapture = async (cli: TestCli, steps: string | undefined) => {
  const arguments_ = [
    "capture-native-ui-scenario",
    "/provider-must-not-be-invoked",
    "--pid",
    "1",
    "--window-id",
    "1",
  ];
  if (steps !== undefined) arguments_.push("--steps", steps);
  arguments_.push("--json");
  return cli.run({
    arguments: arguments_,
    environment: { REA_LOG_LEVEL: "silent" },
  });
};

const runWithBothCaptureSourcesDisabled = async (
  cli: TestCli,
  command: "observe-native-ui" | "capture-native-ui-scenario",
  path: string,
) => {
  const arguments_ = [
    command,
    path,
    "--pid",
    "1",
    "--window-id",
    "1",
    "--screenshot=false",
    "--accessibility=false",
  ];
  if (command === "capture-native-ui-scenario")
    arguments_.push("--steps", '[{"kind":"wait","milliseconds":0}]');
  arguments_.push("--json");
  return cli.run({
    arguments: arguments_,
    environment: { REA_LOG_LEVEL: "silent" },
  });
};

describe("native UI scenario CLI input", () => {
  cliTest(
    "advertises the capture source requirement for both commands",
    async ({ cli }) => {
      for (const command of [
        "observe-native-ui",
        "capture-native-ui-scenario",
      ]) {
        const result = await cli.run({
          arguments: [command, "--schema", "--json"],
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({
          options: {
            properties: {
              screenshot: {
                description:
                  nativeUiObservationInputSchema.shape.screenshot.description,
              },
              accessibility: {
                description:
                  nativeUiObservationInputSchema.shape.accessibility
                    .description,
              },
            },
          },
        });
      }
    },
  );

  cliTest.skipIf(process.platform !== "darwin")(
    "explains why both capture sources cannot be disabled",
    async ({ cli }) => {
      const directory = await createTestTempDirectory(
        "rea-native-ui-capture-mode-",
      );
      const target = join(directory, "target");
      await writeFile(target, thinMach(0xfeedfacf, 0x0100000c));
      for (const command of [
        "observe-native-ui",
        "capture-native-ui-scenario",
      ] as const) {
        const result = await runWithBothCaptureSourcesDisabled(
          cli,
          command,
          target,
        );
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          message: expect.stringMatching(/screenshot.*accessibility/iu),
          details: {
            issues: [
              { path: ["screenshot"], reason: "invalid_value" },
              { path: ["accessibility"], reason: "invalid_value" },
            ],
          },
          remediation: {
            action: expect.stringMatching(/screenshot.*accessibility.*true/iu),
          },
        });
      }
    },
  );

  cliTest(
    "rejects omitted steps at CLI argument admission",
    async ({ cli }) => {
      const result = await runCapture(cli, undefined);

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          expect.objectContaining({ path: "steps", missing: true }),
        ],
      });
    },
  );

  cliTest("rejects malformed JSON as invalid input", async ({ cli }) => {
    const result = await runCapture(cli, "[");

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_native_ui_scenario",
        issues: [
          {
            path: ["steps"],
            reason: "invalid_format",
            expected: "JSON",
          },
        ],
      },
    });
  });

  cliTest(
    "requires at least one schema-valid scenario step",
    async ({ cli }) => {
      const result = await runCapture(cli, "[]");

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "capture_native_ui_scenario",
          issues: [{ path: ["steps"], reason: "out_of_range", minimum: 1 }],
        },
      });
    },
  );

  cliTest(
    "refuses scenario steps on passive observation instead of dropping them",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "observe-native-ui",
          "/provider-must-not-be-invoked",
          "--pid",
          "1",
          "--window-id",
          "1",
          "--steps",
          '[{"kind":"wait","milliseconds":0}]',
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("Unknown flag: --steps");
    },
  );
});
