import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const TEST_FILES = ["tests/**/*.test.ts"];
const PROCESS_CAPTURE_TEST = "tests/processCapture.test.ts";
const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());
const SERIAL_INTEGRATION_TESTS = [
  "tests/applicationWorkflowCli.test.ts",
  "tests/browserCli.test.ts",
  "tests/cliOutput.test.ts",
  "tests/electronCli.test.ts",
  "tests/javascriptArtifactReconstruction.test.ts",
  PROCESS_CAPTURE_TEST,
  "tests/runtime.test.ts",
];
const dualCoreProjects =
  availableParallelism() === 2
    ? {
        maxWorkers: 2,
        projects: [
          {
            test: {
              name: "parallel",
              include: TEST_FILES,
              exclude: SERIAL_INTEGRATION_TESTS,
            },
          },
          {
            test: {
              name: "serial-integration",
              include: SERIAL_INTEGRATION_TESTS,
              fileParallelism: false,
            },
          },
        ],
      }
    : {};

export default defineConfig({
  test: {
    include: TEST_FILES,
    env: { TMPDIR: CANONICAL_TEMPORARY_DIRECTORY },
    ...dualCoreProjects,
    retry: 2,
    reporters: ["default", "verbose"],
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(
        tmpdir(),
        `rea-vitest-coverage-${String(process.pid)}`,
      ),
      include: ["src/**"],
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 60,
        lines: 68,
      },
      reporter: ["text", "text-summary"],
    },
  },
});
