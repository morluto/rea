import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

export const TEST_FILES = ["tests/**/*.test.ts"];
const IS_CONTINUOUS_INTEGRATION = process.env.CI === "true";
// Subprocess-heavy parallel tests exceed their existing deadlines above two workers.
const MAX_TEST_WORKERS = 2;
const PROCESS_CAPTURE_TEST = "tests/processCapture.test.ts";
const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());
export const SERIAL_INTEGRATION_TESTS = [
  "tests/applicationWorkflowCli.test.ts",
  "tests/browserCli.test.ts",
  "tests/cliOutput.test.ts",
  "tests/electronCli.test.ts",
  "tests/javascriptArtifactReconstruction.test.ts",
  PROCESS_CAPTURE_TEST,
  "tests/runtime.test.ts",
];
const isolatedProjects = {
  maxWorkers: Math.min(MAX_TEST_WORKERS, availableParallelism()),
  projects: [
    {
      extends: true as const,
      test: {
        name: "parallel",
        include: TEST_FILES,
        exclude: SERIAL_INTEGRATION_TESTS,
        sequence: { groupOrder: 0 },
      },
    },
    {
      extends: true as const,
      test: {
        name: "serial-integration",
        include: SERIAL_INTEGRATION_TESTS,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    },
  ],
};

export default defineConfig({
  test: {
    env: { TMPDIR: CANONICAL_TEMPORARY_DIRECTORY },
    ...isolatedProjects,
    retry: IS_CONTINUOUS_INTEGRATION ? 2 : 0,
    reporters: ["default"],
    coverage: {
      enabled: false,
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
