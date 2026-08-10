import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  captureProcessScenario,
  probeProcessCaptureCapability,
} from "../../../src/application/ProcessHarness.js";
import {
  parseProcessScenario,
  type ProcessCapture,
} from "../../../src/domain/processCapture.js";
import { processCaptureIssues } from "../../fixtures/processCapture.js";

function createInteractiveScenario(root: string, script: string) {
  return parseProcessScenario({
    approved: true,
    executable: process.execPath,
    arguments: [script],
    working_directory: root,
    reactive: {
      version: 1,
      initial_state: "waiting",
      deadline_ms: 5_000,
      states: [
        {
          id: "waiting",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              id: "answer",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "terminal_text",
                view: "decoded",
                encoding: "utf8",
                literal: "Ready",
                case_sensitive: true,
                control_sequences: "include",
                occurrence: 1,
                since: { kind: "scenario_start" },
                consume: true,
              },
              actions: [
                { type: "send_input", data: "accepted\n", sensitive: true },
                { type: "close_stdin" },
              ],
              target: { kind: "goto", state: "finishing" },
            },
          ],
        },
        {
          id: "finishing",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              id: "complete",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "terminal_text",
                view: "decoded",
                encoding: "utf8",
                literal: "Done",
                case_sensitive: true,
                control_sequences: "include",
                occurrence: 1,
                since: { kind: "state_entry" },
                consume: true,
              },
              actions: [],
              target: { kind: "finish", outcome: "passed" },
            },
          ],
        },
      ],
    },
  });
}

function assertCompletedCapture(capture: ProcessCapture): void {
  expect(capture.reactive_run).toMatchObject({
    status: "finished",
    outcome: "passed",
    active_state: "finishing",
  });
  expect(
    capture.reactive_run?.transitions.map(({ transition_id }) => transition_id),
  ).toEqual(["answer", "complete"]);
  expect(capture.interaction_events).toContainEqual(
    expect.objectContaining({
      type: "input",
      data: "<redacted-input:9-bytes>",
      outcome: "dispatched",
    }),
  );
  expect(capture.interaction_events).toContainEqual(
    expect.objectContaining({
      type: "stdin_close",
      data: "",
      outcome: "dispatched",
    }),
  );
  expect(capture.frames.map(({ data }) => data).join("")).toContain("Done");
  expect(capture.manifest.comparison_contract).toHaveProperty("reactive");
  expect(JSON.stringify(capture.manifest.comparison_contract)).not.toContain(
    "accepted",
  );
  expect(JSON.stringify(capture.manifest.scenario)).not.toContain("accepted");
}

function assertControlAndTransitionValidation(capture: ProcessCapture): void {
  const reactiveRun = capture.reactive_run;
  if (reactiveRun === null) throw new Error("reactive result missing");
  const lastOrder = capture.event_journal
    ?.filter(({ collection }) =>
      [
        "frames",
        "interaction_events",
        "filesystem_checkpoints",
        "shim_events",
      ].includes(collection),
    )
    .at(-1)?.capture_order;
  if (lastOrder === undefined)
    throw new Error("reactive observation order missing");
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: {
        ...reactiveRun,
        controls: [
          ...reactiveRun.controls,
          {
            sequence: reactiveRun.controls.length,
            kind: "target_lost",
            after_capture_order: lastOrder,
          },
        ],
      },
    }),
  ).toContainEqual(
    expect.objectContaining({
      path: `reactive_run.controls[${String(reactiveRun.controls.length)}]`,
      message: "reactive control cannot follow a finished run",
    }),
  );
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: {
        ...reactiveRun,
        transitions: reactiveRun.transitions.map((transition, index) =>
          index === 0
            ? { ...transition, transition_id: "fabricated" }
            : transition,
        ),
      },
    }),
  ).toContainEqual(
    expect.objectContaining({
      path: "reactive_run.transitions[0]",
      message:
        "reactive transition is not declared by its recorded source state",
    }),
  );
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: {
        status: "finished",
        outcome: "passed",
        active_state: "waiting",
        transitions: [],
        controls: [],
      },
    }),
  ).toContainEqual(
    expect.objectContaining({
      path: "reactive_run.outcome",
      message: "reactive outcome differs from deterministic journal replay",
    }),
  );
  const suffix = reactiveRun.transitions
    .slice(1)
    .map((transition, sequence) => ({
      ...transition,
      sequence,
    }));
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: { ...reactiveRun, transitions: suffix },
    }),
  ).toContainEqual(
    expect.objectContaining({
      path: "reactive_run.transitions[0].state_before",
      message:
        "reactive transition journal must start at the declared initial state",
    }),
  );
}

function assertReplayValidation(capture: ProcessCapture): void {
  const reactiveRun = capture.reactive_run;
  if (reactiveRun === null) throw new Error("reactive result missing");
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: {
        ...reactiveRun,
        transitions: reactiveRun.transitions.map((transition, index) =>
          index === 0
            ? { ...transition, trigger_event_ids: [], action_event_ids: [] }
            : transition,
        ),
      },
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "reactive_run.transitions",
        message: expect.stringContaining(
          "reactive transition journal is not reproduced",
        ),
      }),
      expect.objectContaining({
        path: "reactive_run.transitions[0].action_event_ids",
        message: expect.stringContaining(
          "recorded action observations do not match proposed effects",
        ),
      }),
    ]),
  );
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: { ...reactiveRun, status: "running", outcome: null },
    }),
  ).toContainEqual(
    expect.objectContaining({
      message: "completed capture requires a finished reactive outcome",
    }),
  );
  expect(
    processCaptureIssues({
      ...capture,
      reactive_run: {
        ...reactiveRun,
        transitions: [
          reactiveRun.transitions[0]!,
          { ...reactiveRun.transitions[0]!, sequence: 1 },
        ],
      },
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: "reactive transition states must be contiguous",
      }),
      expect.objectContaining({
        message:
          "reactive transition differs from deterministic journal replay",
      }),
    ]),
  );
}

it("drives a process from terminal observations and retains the reactive transition journal", async () => {
  const root = await createTestTempDirectory("rea-reactive-harness-test-");
  const script = join(root, "reactive.mjs");
  await writeFile(
    script,
    [
      'import { createInterface } from "node:readline";',
      "const input = createInterface({ input: process.stdin, terminal: false });",
      'process.stdout.write("Ready\\n");',
      'input.once("line", () => { process.stdout.write("Done\\n"); input.close(); });',
    ].join("\n"),
  );
  const scenario = createInteractiveScenario(root, script);
  try {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(scenario, {
      status: "enabled",
      executableRoots: [dirname(process.execPath)],
      workingRoots: [root],
      allowedEnvironment: [],
      networkAccess: "external",
    });
    if (!result.ok) throw result.error;
    assertCompletedCapture(result.value);
    assertControlAndTransitionValidation(result.value);
    assertReplayValidation(result.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records target loss before post-exit settlement can win the deadline race", async () => {
  const root = await createTestTempDirectory("rea-reactive-target-loss-test-");
  const script = join(root, "exit.mjs");
  await writeFile(script, 'process.stdout.write("exiting\\n");\n');
  const scenario = parseProcessScenario({
    approved: true,
    executable: process.execPath,
    arguments: [script],
    working_directory: root,
    settle_ms: 500,
    reactive: {
      version: 1,
      initial_state: "waiting",
      deadline_ms: 5_000,
      states: [
        {
          id: "waiting",
          max_visits: 1,
          // Leave process startup scheduling headroom; this test targets
          // post-exit settlement ordering, not a 300ms startup deadline.
          deadline_ms: 2_000,
          on: [
            {
              id: "unreachable",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "terminal_text",
                view: "decoded",
                encoding: "utf8",
                literal: "never-produced",
                case_sensitive: true,
                control_sequences: "include",
                occurrence: 1,
                since: { kind: "scenario_start" },
                consume: true,
              },
              actions: [],
              target: { kind: "finish", outcome: "passed" },
            },
          ],
        },
      ],
    },
  });
  try {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(scenario, {
      status: "enabled",
      executableRoots: [dirname(process.execPath)],
      workingRoots: [root],
      allowedEnvironment: [],
      networkAccess: "external",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.reactive_run).toMatchObject({
      status: "finished",
      outcome: "target_lost",
      active_state: "waiting",
      transitions: [],
      controls: [
        expect.objectContaining({
          kind: "target_lost",
        }),
      ],
    });
    const frame = result.value.frames.at(-1);
    const journal = result.value.event_journal;
    const reactiveRun = result.value.reactive_run;
    if (frame === undefined || journal === undefined || reactiveRun === null)
      throw new Error("ordered reactive evidence missing");
    const laterCaptureOrder = journal.length;
    const withLaterMatch = {
      ...result.value,
      frames: [
        ...result.value.frames,
        {
          ...frame,
          sequence: result.value.frames.length,
          at_ms: frame.at_ms + 1,
          data: "never-produced",
        },
      ],
      event_journal: [
        ...journal,
        {
          capture_order: laterCaptureOrder,
          collection: "frames" as const,
          index: result.value.frames.length,
        },
      ],
    };
    expect(
      processCaptureIssues(withLaterMatch).filter(({ path }) =>
        path.startsWith("reactive_run"),
      ),
    ).toEqual([]);
    expect(
      processCaptureIssues({
        ...withLaterMatch,
        reactive_run: {
          ...reactiveRun,
          controls: reactiveRun.controls.map((control) => ({
            ...control,
            after_capture_order: laterCaptureOrder,
          })),
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        path: "reactive_run.outcome",
        message: "reactive outcome differs from deterministic journal replay",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
