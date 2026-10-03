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
// Local runs share the host with TypeScript, docs, and package checks under
// Turbo. Running the suite on a single worker made a full local run cost ~140s
// of wall time at ~100% CPU on a 10-core machine, which was the single largest
// dev-cycle cost in the repository. Two workers matches the budget CI already
// proves green, so local and CI now execute the same concurrency.
//
// Do not raise this without first removing the wall-clock-sensitive PTY
// scenarios in tests/boundary/process, which fail under host contention
// because they schedule actions by `at_ms` instead of observed output.
const MAX_TEST_WORKERS = Math.min(2, availableParallelism());

// Cross-project scheduling is a local-host concern only. CI shards projects
// across separate runners and already proves this concurrency green.
const LOCAL_ONLY = process.env.CI !== "true";

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
      "src/{artifacts,browser,dotnet,ghidra,hopper,native,process,reference,replay,server}/**/*.test.ts",
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
    exclude: [
      "tests/boundary/mcp/**/*.test.ts",
      "tests/boundary/process/**/*.test.ts",
    ],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    // Real PTY capture scenarios contend for host process and terminal
    // resources, and several still schedule actions by wall-clock `at_ms`
    // rather than observed output. Running them concurrently with the rest of
    // the boundary suite makes them drop input and lose resize echoes. They
    // serialise until those scenarios trigger on observed terminal text.
    name: "process-boundary",
    include: ["tests/boundary/process/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    fileParallelism: false,
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
  // Acceptance, process-boundary, and process-global declare
  // `fileParallelism: false` above because they own host-level process, stdio,
  // and terminal state. That flag only serialises files inside one project, so
  // each project also needs its own `sequence.groupOrder` locally: without it
  // Vitest runs projects concurrently and a project that mutates host process
  // or terminal state overlaps with projects that observe it.
].map((project, groupOrder) => ({
  ...project,
  maxWorkers: MAX_TEST_WORKERS,
  ...(LOCAL_ONLY ? { sequence: { groupOrder } } : {}),
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
