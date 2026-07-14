import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

const TEST_FILES = ["tests/**/*.test.ts"];
const PROCESS_CAPTURE_TEST = "tests/processCapture.test.ts";
const SERIAL_INTEGRATION_TESTS = [
  "tests/browserCli.test.ts",
  "tests/cliOutput.test.ts",
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
    ...dualCoreProjects,
    retry: 2,
    reporters: ["default", "verbose"],
    coverage: {
      enabled: true,
      provider: "v8",
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
