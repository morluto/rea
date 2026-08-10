import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());
const COVERAGE_ENABLED = process.argv.some((argument) =>
  argument.startsWith("--coverage"),
);
const COVERAGE_SHARD = process.argv.some((argument) =>
  argument.startsWith("--shard="),
);
const LOCAL_ONLY = process.env.CI !== "true";

// Keep local runs to one worker and one project at a time. CI shards have
// dedicated capacity and retain the existing bounded worker budget.
export const MAX_TEST_WORKERS = LOCAL_ONLY
  ? 1
  : Math.min(2, availableParallelism());

export const TEST_PROJECTS = [
  {
    name: "domain",
    include: ["src/{contracts,domain}/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Domain and contract modules are pure and own no process-global state, so
    // per-file module isolation adds startup cost without protecting a seam.
    isolate: false,
  },
  {
    name: "services",
    include: ["src/application/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Service tests use recording ports and own no process-global state. Share
    // their module graph so file startup does not dominate the lane.
    isolate: false,
  },
  {
    name: "adapters",
    include: [
      "src/config*.test.ts",
      "src/{artifacts,browser,dotnet,ghidra,hopper,native,process,reference,replay}/**/*.test.ts",
    ],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "composition",
    include: ["tests/composition/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "boundary",
    include: ["tests/boundary/**/*.test.ts"],
    exclude: ["tests/boundary/mcp/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "mcp-boundary",
    include: ["tests/boundary/mcp/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "acceptance",
    include: ["tests/acceptance/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    fileParallelism: false,
  },
  {
    name: "process-global",
    include: ["tests/process-global/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    fileParallelism: false,
  },
  {
    name: "conformance",
    include: ["tests/conformance/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "evaluation",
    include: ["tests/evaluation/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
].map((project, groupOrder) => ({
  ...project,
  maxWorkers: MAX_TEST_WORKERS,
  ...(LOCAL_ONLY ? { fileParallelism: false, sequence: { groupOrder } } : {}),
}));

const ZERO_COVERAGE_THRESHOLDS = {
  statements: 0,
  branches: 0,
  functions: 0,
  lines: 0,
  "src/domain/**": {
    statements: 0,
    branches: 0,
    functions: 0,
    lines: 0,
  },
  "src/contracts/**": {
    statements: 0,
    branches: 0,
    functions: 0,
    lines: 0,
  },
};

const projects = TEST_PROJECTS.map((project) => ({
  extends: true as const,
  test: project,
}));

export default defineConfig({
  test: {
    env: { TMPDIR: CANONICAL_TEMPORARY_DIRECTORY },
    maxWorkers: MAX_TEST_WORKERS,
    projects,
    retry: 0,
    reporters: ["default"],
    // Boundary projects may compete with TypeScript, docs, and package checks
    // under Turbo. Keep the deadline bounded while avoiding false failures from
    // host-level CPU and filesystem contention.
    testTimeout: COVERAGE_ENABLED ? 60_000 : 30_000,
    coverage: {
      enabled: false,
      provider: "v8",
      reportsDirectory: join(
        tmpdir(),
        `rea-vitest-coverage-${String(process.pid)}`,
      ),
      include: ["src/**"],
      thresholds: COVERAGE_SHARD
        ? ZERO_COVERAGE_THRESHOLDS
        : {
            statements: 65,
            branches: 60,
            functions: 60,
            lines: 68,
            "src/domain/**": {
              statements: 80,
              branches: 75,
              functions: 75,
              lines: 80,
            },
            "src/contracts/**": {
              statements: 85,
              branches: 80,
              functions: 80,
              lines: 85,
            },
          },
      reporter: ["text", "text-summary"],
    },
  },
});
