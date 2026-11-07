import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const harness = fileURLToPath(
  new URL("../../fixtures/goVerifierCleanupHarness.mjs", import.meta.url),
);

const outcomeSchema = z.object({
  failure: z.object({
    name: z.string().optional(),
    message: z.string().optional(),
    retained_root: z.string().nullable(),
    messages: z.array(z.string()),
  }),
  report: z.object({
    status: z.string().optional(),
    retained_root: z.string().nullable(),
    descendants: z.number().nullable(),
    lineage_status: z.string().optional(),
    lineage_reason: z.string().nullable(),
    omitted_coverage: z.array(z.string()),
  }),
  retained_at_failure: z.array(z.string()),
  retained_after_retry: z.array(z.string()).optional(),
  root_removed_after_retry: z.boolean().optional(),
  events: z.array(z.string()),
});

/** Run the actual verifier with a fake compiler and one authored fault. */
const runScenario = async (processes: TestProcesses, scenario: string) => {
  const root = await createTestTempDirectory("rea-go-verifier-cleanup-");
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const result = await processes.run(process.execPath, [harness, scenario], {
    env: {
      ...process.env,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    },
    timeoutMs: 40_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return outcomeSchema.parse(JSON.parse(result.stdout));
};

const PRIMARY = /ENOENT.*linux-amd64/u;
const posixTest = processTest.skipIf(process.platform === "win32");

posixTest(
  "releases a real MCP server before its root and keeps the verification failure",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "real-server");
    expect(outcome.failure.messages).toEqual([expect.stringMatching(PRIMARY)]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: null,
      descendants: 0,
    });
    expect(outcome.retained_at_failure).toEqual([]);
    expect(outcome.events.indexOf("child-close")).toBeGreaterThanOrEqual(0);
    expect(outcome.events.indexOf("root-close")).toBeGreaterThan(
      outcome.events.indexOf("child-close"),
    );
  },
);

posixTest.for([
  ["client-constructor", /^authored client constructor failure$/u],
  ["transport-constructor", /^authored transport constructor failure$/u],
  ["missing-compiler", /requires Go on PATH/u],
  ["spawn-failure", /absent-node ENOENT/u],
] as const)(
  "removes the root and keeps the %s failure before any child exists",
  async ([scenario, message], { processes }) => {
    const outcome = await runScenario(processes, scenario);
    expect(outcome.failure.messages).toEqual([expect.stringMatching(message)]);
    expect(outcome.report.retained_root).toBeNull();
    expect(outcome.retained_at_failure).toEqual([]);
    // A spawn that failed still reports close; no process ever existed.
    expect(outcome.events).not.toContain("child-exit");
    expect(outcome.events.at(-1)).toBe("root-close");
  },
);

posixTest(
  "retains the root when the SDK no longer exposes its child",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "unobservable-child");
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(/child handle/u),
      expect.stringMatching(/child handle/u),
    ]);
    expect(outcome.retained_at_failure).toHaveLength(1);
    expect(outcome.events).toEqual(["retry-refused"]);
  },
);

posixTest.for([
  ["refused-handshake", /authored handshake refusal/u],
  // Unread output would keep the child's pipe open past its exit.
  ["noisy-stderr", PRIMARY],
] as const)(
  "finishes a %s child before removing the root",
  async ([scenario, message], { processes }) => {
    const outcome = await runScenario(processes, scenario);
    expect(outcome.failure.messages).toEqual([expect.stringMatching(message)]);
    expect(outcome.retained_at_failure).toEqual([]);
    expect(outcome.events.indexOf("root-close")).toBeGreaterThan(
      outcome.events.indexOf("child-close"),
    );
  },
);

posixTest.for([
  ["client-close", ["authored client close failure"]],
  ["transport-close", ["authored transport close failure"]],
  [
    "both-closes",
    ["authored client close failure", "authored transport close failure"],
  ],
  ["root-close", ["authored root close failure"]],
] as const)(
  "retains and reports the root after a %s failure, then retries",
  async ([scenario, cleanupMessages], { processes }) => {
    const outcome = await runScenario(processes, scenario);
    // The primary failure stays first, and every cleanup failure follows it.
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(PRIMARY),
      ...cleanupMessages,
    ]);
    expect(outcome.retained_at_failure).toHaveLength(1);
    const retained = outcome.retained_at_failure[0]!;
    expect(outcome.failure.retained_root).toBe(retained);
    expect(outcome.report.retained_root).toBe(retained);
    expect(outcome.failure.message).toContain(retained);
    // An owner that refused to close can still own a running child; the transport
    // stops that child itself, so the proof holds whichever close failed.
    const failedAttempt = outcome.events.indexOf("child-close");
    expect(failedAttempt).toBeGreaterThanOrEqual(0);
    expect(outcome.events.indexOf("root-close")).toBeGreaterThan(failedAttempt);
    expect(outcome.root_removed_after_retry).toBe(true);
    expect(outcome.retained_after_retry).toEqual([]);
  },
);

posixTest(
  "waits for a child that exits only after the final kill",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "late-exit");
    expect(outcome.failure.messages).toEqual([expect.stringMatching(PRIMARY)]);
    expect(outcome.retained_at_failure).toEqual([]);
    expect(outcome.events).toEqual([
      "final-kill",
      "child-exit",
      "child-close",
      "root-close",
    ]);
  },
);

posixTest(
  "retains the root while the final kill has not ended the child",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "undelivered-kill");
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(PRIMARY),
      expect.stringMatching(/completion.*did not exit after SIGKILL/u),
    ]);
    expect(outcome.retained_at_failure).toHaveLength(1);
    expect(outcome.report.retained_root).toBe(outcome.retained_at_failure[0]);
    // The running child is still visible to the report's lineage observation.
    expect(outcome.report.descendants).toBe(1);
    const refused = outcome.events.indexOf("retry-refused");
    expect(refused).toBeGreaterThan(0);
    expect(outcome.events.slice(0, refused)).not.toContain("root-close");
    expect(outcome.events.slice(refused)).toEqual([
      "retry-refused",
      "child-exit",
      "child-close",
      "root-close",
    ]);
    expect(outcome.root_removed_after_retry).toBe(true);
  },
);

posixTest(
  "retains the root while a surviving process holds the child's pipes",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "pipe-holder");
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(PRIMARY),
      expect.stringMatching(/pipes/u),
    ]);
    expect(outcome.retained_at_failure).toHaveLength(1);
    // Reparented on exit, so only the open pipes reveal it.
    expect(outcome.report.descendants).toBe(0);
    const refused = outcome.events.indexOf("retry-refused");
    expect(outcome.events.slice(0, refused)).toEqual(["child-exit"]);
    expect(outcome.events.slice(refused)).toEqual([
      "retry-refused",
      "child-close",
      "root-close",
    ]);
    expect(outcome.root_removed_after_retry).toBe(true);
  },
);

posixTest(
  "retains the root while another owned descendant is live",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "live-descendant");
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(PRIMARY),
      "Owned descendants survived verifier cleanup",
    ]);
    expect(outcome.report).toMatchObject({
      lineage_status: "verified",
      descendants: 1,
    });
    expect(outcome.retained_at_failure).toHaveLength(1);
    expect(outcome.root_removed_after_retry).toBe(true);
  },
);

posixTest.for([
  ["failed-snapshot", /lineage could not be inspected/u],
  ["unreadable-environment", /descendant \d+ environment was unreadable/u],
  ["foreign-descendant", /descendant \d+ run token did not match/u],
] as const)(
  "retains the root while lineage is unknown after a %s, then retries",
  async ([scenario, reason], { processes }) => {
    const outcome = await runScenario(processes, scenario);
    expect(outcome.failure.messages).toEqual([
      expect.stringMatching(PRIMARY),
      expect.stringMatching(reason),
    ]);
    expect(outcome.report.lineage_status).toBe("unavailable");
    expect(outcome.report.lineage_reason).toMatch(reason);
    expect(outcome.retained_at_failure).toHaveLength(1);
    expect(outcome.report.retained_root).toBe(outcome.retained_at_failure[0]);
    const released = outcome.events.indexOf("root-close");
    expect(released).toBeGreaterThan(outcome.events.indexOf("child-close"));
    // The child's proof alone did not release it: only the retry reached the root.
    expect(outcome.events.filter((kind) => kind === "root-close")).toHaveLength(
      1,
    );
    expect(outcome.root_removed_after_retry).toBe(true);
    expect(outcome.report.omitted_coverage).toEqual([]);
  },
);

posixTest(
  "releases the root where lineage has no facility, and says what that leaves unproven",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "windows-lineage");
    expect(outcome.failure.messages).toEqual([expect.stringMatching(PRIMARY)]);
    expect(outcome.report).toMatchObject({
      retained_root: null,
      lineage_status: "unavailable",
      lineage_reason: expect.stringMatching(/Job Object/u),
      omitted_coverage: [
        expect.stringMatching(/MCP child's completion alone/u),
      ],
    });
    expect(outcome.retained_at_failure).toEqual([]);
    expect(outcome.events.indexOf("root-close")).toBeGreaterThan(
      outcome.events.indexOf("child-close"),
    );
  },
);
