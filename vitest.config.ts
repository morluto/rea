import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

import { CiTestSequencer } from "./tests/ciTestSequencer.js";

// Playwright's registry does not derive a cache directory for Termux's
// `android` platform. Match the production CLI fallback before workers import
// browser modules.
if (
  process.platform === "android" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
) {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
}

const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());
const COVERAGE_ENABLED = process.argv.some((argument) =>
  argument.startsWith("--coverage"),
);
const COVERAGE_SHARD = process.argv.some((argument) =>
  argument.startsWith("--shard="),
);
// Keep local and CI concurrency bounded by the runner rather than command locks.
const MAX_TEST_WORKERS = Math.min(2, availableParallelism());

const TEST_PROJECTS = [
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
      "src/*.test.ts",
      "src/{apktool,jeb,adb,artifacts,browser,dotnet,evm,firmware,ghidra,go,hopper,ida,inspector,javascript,native,process,reference,server,wasm,windows}/**/*.test.ts",
    ],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "composition",
    include: ["tests/composition/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Composition tests use provider-neutral sessions and test-scoped cleanup;
    // sharing their immutable module graph avoids per-file startup work.
    isolate: false,
  },
  {
    name: "boundary",
    include: ["tests/boundary/**/*.test.ts"],
    exclude: [
      "tests/boundary/cli/**/*.test.ts",
      "tests/boundary/mcp/**/*.test.ts",
      "tests/boundary/process/**/*.test.ts",
    ],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "cli-boundary",
    include: ["tests/boundary/cli/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // CLI tests create fresh command instances or subprocesses and own their
    // cleanup. Reuse the immutable graph; module mocks belong in process-global.
    isolate: false,
    // Long-lived workers should collect temporary command/schema allocations
    // before their two heaps compete with the real CLI child processes.
    execArgv: ["--max-old-space-size=384"],
  },
  {
    // Process-tree observations share host sampling resources; keep this small
    // lane serial while the independent projects run together.
    name: "process-boundary",
    include: ["tests/boundary/process/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    fileParallelism: false,
    sequence: { groupOrder: 1 },
  },
  {
    name: "mcp-boundary",
    include: ["tests/boundary/mcp/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Each file creates and closes an explicit in-memory MCP session. Reuse the
    // immutable server graph so module startup does not outweigh transport work.
    isolate: false,
  },
  {
    name: "acceptance",
    include: ["tests/acceptance/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "process-global",
    include: ["tests/process-global/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "conformance",
    include: ["tests/conformance/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Contract cases use recording providers and own no process-global state.
    isolate: false,
  },
  {
    name: "evaluation",
    include: ["tests/evaluation/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Evaluator tests inspect deterministic inputs without mutating shared state.
    isolate: false,
  },
];

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
    ...(process.env.REA_CI_TEST_HISTORY
      ? { sequence: { sequencer: CiTestSequencer } }
      : {}),
    retry: 0,
    reporters: ["default"],
    runner: "./tests/processOwnershipRunner.ts",
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
