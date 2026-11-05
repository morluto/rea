import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  buildComputerFakes,
  bundleFolder,
  callOk,
  connectBuildServer,
  expectNoToken,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import {
  FAKE_SEGMENTS,
  type FakeApp,
} from "../../fixtures/fakeAgentEnvComputer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const TASK = {
  name: "add-eggs",
  prompt: "Add eggs to today's list and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/today.txt", lines: ["eggs"] },
  ],
};
const lines = (...text: string[]) => ({
  "Documents/today.txt": {
    format: "text",
    view: { lines: text, line_count: text.length, truncated: false },
    truncated: false,
  },
});

const witnessed = async (slowReset = 0) => {
  const app: FakeApp = {
    name: "notes",
    state: lines("milk"),
    seed: lines("milk"),
    methods: [],
    unreadyAfterReset: slowReset,
  };
  const { computer, runner } = await buildComputerFakes({ app });
  const client = await connectBuildServer(runner.environment);
  const id = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  const directory = join(await createTestTempDirectory("witness-"), "add-eggs");
  const check = (fields: Record<string, unknown>) =>
    client.callTool({
      name: "check_build_task",
      arguments: { computer_id: id, task: TASK, ...fields },
    });
  const act = (action: string, fields: Record<string, unknown> = {}) =>
    callOk(client, "act_on_build_computer", {
      computer_id: id,
      action,
      ...fields,
    });
  return { app, computer, client, id, directory, check, act };
};

/** Act on the app and set its state as that act would leave it. */
const edit = async (
  witness: Awaited<ReturnType<typeof witnessed>>,
  state: Record<string, unknown>,
) => {
  await witness.act("type", { text: "x" });
  witness.app.state = state;
};

const parsed = (result: unknown) =>
  toolContract("check_build_task").outputSchema.parse(
    (result as { structuredContent: unknown }).structuredContent,
  );

it("witnesses a task: the seed fails, the edit passes, a near miss fails and so does the reset seed", async () => {
  const { app, computer, directory, check, act } = await witnessed();

  // A plain check grades the live state, one result per check, and files nothing.
  const plain = parsed(await check({}));
  expect(plain).toMatchObject({
    task: "add-eggs",
    passed: 0,
    failed: 1,
    results: [
      {
        id: "check-1",
        passed: false,
        description: 'Documents/today.txt has no line "eggs"',
      },
    ],
    witness: null,
  });

  const seed = parsed(await check({ stage: "seed", directory }));
  expect(seed.witness).toMatchObject({
    stage: "seed",
    expectation: "some_fail",
    held: true,
    status: "open",
    next_stage: "after_edit",
  });
  expect(
    parseMcpToolError(await check({ stage: "after_edit" })).error.message,
  ).toContain("act on the app");

  await act("screenshot");
  await act("type", { text: "eggs\n" });
  app.state = lines("milk", "eggs");
  expect(parsed(await check({ stage: "after_edit" })).witness).toMatchObject({
    held: true,
    next_stage: "near_miss",
  });

  await act("key", { keys: ["BackSpace"] });
  app.state = lines("milk", "egg");
  expect(parsed(await check({ stage: "near_miss" })).witness).toMatchObject({
    held: true,
    next_stage: "after_reset",
  });
  expect(
    parseMcpToolError(await check({ stage: "after_reset" })).error.message,
  ).toContain("reset");

  const reset = await act("reset", { screenshot: true });
  expect(reset.content.some((block) => block.type === "image")).toBe(true);
  expect(app.state).toEqual(app.seed);
  const last = await check({ stage: "after_reset" });
  expectNoToken(computer, last);
  const { witness } = parsed(last);
  expect(witness).toMatchObject({
    stage: "after_reset",
    held: true,
    status: "held",
    next_stage: null,
  });
  const record = witness?.record;
  expect(record).toMatchObject({
    path: join(directory, "witness.json"),
    verdict: "held",
    failed_stage: null,
    task: { name: "add-eggs" },
    recording: {
      recording_id: "rec-000000000001",
      segments: FAKE_SEGMENTS.map((bytes, index) => ({
        path: `recording/000${String(index)}.mp4`,
        bytes: bytes.length,
      })),
    },
  });
  expect(record?.stages.map((stage) => [stage.stage, stage.held])).toEqual([
    ["seed", true],
    ["after_edit", true],
    ["near_miss", true],
    ["after_reset", true],
  ]);
  expect(record?.stages.map((stage) => stage.results[0]?.passed)).toEqual([
    false,
    true,
    false,
    false,
  ]);
  expect(
    record?.actions.map(({ action, tool, outcome }) => [action, tool, outcome]),
  ).toEqual([
    ["screenshot", "computer_screenshot", "applied"],
    ["type", "computer_type", "applied"],
    ["key", "computer_key", "applied"],
    ["reset", "data/reset", "applied"],
  ]);
  expect(app.methods).toEqual([
    "data/get",
    "data/get",
    "data/get",
    "data/get",
    "data/reset",
    "data/get",
  ]);
  for (const [index, bytes] of FAKE_SEGMENTS.entries())
    expect(
      (
        await readFile(join(directory, "recording", `000${String(index)}.mp4`))
      ).equals(bytes),
    ).toBe(true);
  const evidence = parseEvidence(
    JSON.parse(await readFile(join(directory, "witness.json"), "utf8")),
  );
  expect(evidence).toMatchObject({
    evidence_id: record?.evidence_id,
    predicate_type: "rea.desktop-build-witness",
  });
  expect(evidence.normalized_result).toMatchObject({ verdict: "held" });
  expect(
    parseMcpToolError(await check({ stage: "seed", directory })).error.message,
  ).toContain("already witnessed");
});

it("ends the witness when the seed already passes, and refuses its later stages", async () => {
  const { check, act, directory } = await witnessed();
  const passing = {
    ...TASK,
    checks: [
      { kind: "lines_present", file: "Documents/today.txt", lines: ["milk"] },
    ],
  };
  const seed = parsed(await check({ task: passing, stage: "seed", directory }));
  expect(seed.witness).toMatchObject({
    held: false,
    status: "failed",
    record: { verdict: "failed", failed_stage: "seed" },
  });
  await act("type", { text: "eggs\n" });
  expect(
    parseMcpToolError(await check({ task: passing, stage: "after_edit" })).error
      .message,
  ).toContain("ended");
});

it("refuses a witness without a folder for its record, or one already holding files", async () => {
  const { check } = await witnessed();
  expect(
    parseMcpToolError(await check({ stage: "seed" })).error.message,
  ).toContain("directory");
  const used = await createTestTempDirectory("witness-used-");
  await writeFile(join(used, "keep"), "");
  expect(
    parseMcpToolError(await check({ stage: "seed", directory: used })).error
      .message,
  ).toContain("not empty");
});

it("retries a seed whose state read failed, with the recording it began", async () => {
  const witness = await witnessed();
  witness.app.failGets = 1;
  const failed = await witness.check({
    stage: "seed",
    directory: witness.directory,
  });
  expect(parseMcpToolError(failed).error.message).toContain("busy");
  const seed = parsed(
    await witness.check({ stage: "seed", directory: witness.directory }),
  );
  expect(seed.witness).toMatchObject({ held: true, next_stage: "after_edit" });
  expect(
    witness.computer.recordingRequests.filter(({ path }) =>
      path.endsWith("/start"),
    ),
  ).toHaveLength(1);
});

it("records a long witness from the bounded action log, naming what it dropped and what it cut", async () => {
  const witness = await witnessed();
  const { app, check, directory } = witness;
  await check({ stage: "seed", directory });
  for (let index = 0; index < 260; index += 1)
    await witness.act("key", { keys: ["Right"] });
  await witness.act("type", { text: "e".repeat(2048) });
  app.state = lines("milk", "eggs");
  expect(parsed(await check({ stage: "after_edit" })).witness).toMatchObject({
    held: true,
  });
  await edit(witness, lines("milk", "egg"));
  await check({ stage: "near_miss" });
  await witness.act("reset");
  const record = parsed(await check({ stage: "after_reset" })).witness?.record;
  expect(record).toMatchObject({ verdict: "held", actions_dropped: 7 });
  expect(record?.actions).toHaveLength(256);
  expect(record?.actions[0]?.index).toBe(7);
  expect(
    record?.actions.find(({ action }) => action === "type")
      ?.truncated_arguments,
  ).toEqual(["text"]);
  const { limitations } = parseEvidence(
    JSON.parse(await readFile(join(directory, "witness.json"), "utf8")),
  );
  expect(limitations.join("\n")).toContain(
    "the 7 earliest are not in the record",
  );
  expect(limitations.join("\n")).toContain("truncated_arguments");
});

it("saves a witness record again after a failed save, without checking again", async () => {
  const witness = await witnessed();
  const { check, directory, app } = witness;
  await check({ stage: "seed", directory });
  await edit(witness, lines("milk", "eggs"));
  await check({ stage: "after_edit" });
  await edit(witness, lines("milk", "egg"));
  await check({ stage: "near_miss" });
  await witness.act("reset");
  // Something else writes into the record's folder, so the save is refused.
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "intruder"), "");
  const refused = await check({ stage: "after_reset" });
  expect(parseMcpToolError(refused).error.message).toContain("not empty");
  await rm(join(directory, "intruder"));
  const gets = app.methods.length;
  const saved = parsed(await check({ stage: "after_reset" }));
  expect(saved.witness).toMatchObject({
    stage: "after_reset",
    status: "held",
    record: { verdict: "held" },
  });
  expect(saved.witness?.record?.stages).toHaveLength(4);
  expect(app.methods.length).toBe(gets);
  expect(
    parseMcpToolError(await check({ stage: "after_reset" })).error.message,
  ).toContain("ended");
});

it("sends progress while a reset waits for the relaunched app", async () => {
  const witness = await witnessed(14);
  const progress: unknown[] = [];
  const reset = await witness.client.callTool(
    {
      name: "act_on_build_computer",
      arguments: { computer_id: witness.id, action: "reset" },
    },
    { onprogress: (update) => progress.push(update) },
  );
  expect(reset.isError, JSON.stringify(reset)).not.toBe(true);
  expect(progress.length).toBeGreaterThan(0);
}, 30_000);
