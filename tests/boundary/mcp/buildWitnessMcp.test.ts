import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

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
  type FakeComputerOptions,
} from "../../fixtures/fakeAgentEnvComputer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cancelDuringCommit } from "../../fixtures/outputTreeCommit.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const TASK = {
  name: "add-eggs",
  prompt: "Add eggs to today's list and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/today.txt", lines: ["eggs"] },
  ],
};
const WITNESS_ORDER = ["seed", "after_edit", "near_miss", "after_reset"];
const lines = (...text: string[]) => ({
  "Documents/today.txt": {
    format: "text",
    view: { lines: text, line_count: text.length, truncated: false },
    truncated: false,
  },
});

const witnessed = async (slowReset = 0, options: FakeComputerOptions = {}) => {
  const app: FakeApp = {
    name: "notes",
    state: lines("milk"),
    seed: lines("milk"),
    methods: [],
    unreadyAfterReset: slowReset,
  };
  const { computer, runner } = await buildComputerFakes({ ...options, app });
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

/** Check the seed, the edit and the near miss, each after the act it needs. */
const throughNearMiss = async (
  witness: Awaited<ReturnType<typeof witnessed>>,
) => {
  await witness.check({ stage: "seed", directory: witness.directory });
  await edit(witness, lines("milk", "eggs"));
  await witness.check({ stage: "after_edit" });
  await edit(witness, lines("milk", "egg"));
  await witness.check({ stage: "near_miss" });
};

const parsed = (result: unknown) =>
  toolContract("check_build_task").outputSchema.parse(
    (result as { structuredContent: unknown }).structuredContent,
  );

/** A stage its checks leave undecided: refused as a request naming the stage and what left each check undecided, in any wording. */
const expectUndecided = (
  result: CallToolResult,
  stage: string,
  facts: readonly string[],
) => {
  const { error } = parseMcpToolError(result);
  expect(error.code).toBe("invalid_request");
  for (const fact of [stage, ...facts]) expect(error.message).toContain(fact);
};

it("witnesses a task: the seed fails, the edit passes, a near miss fails and so does the reset seed", async () => {
  const { app, computer, directory, check, act } = await witnessed();

  // A plain check grades the live state, one result per check, and files nothing.
  const plain = parsed(await check({}));
  expect(plain).toMatchObject({
    task: "add-eggs",
    passed: 0,
    failed: 1,
    witness: null,
  });
  expect(
    plain.results.map(({ id, passed, undecided }) => ({
      id,
      passed,
      undecided,
    })),
  ).toEqual([{ id: "check-1", passed: false }]);
  for (const fact of ["Documents/today.txt", '"eggs"'])
    expect(plain.results[0]?.description).toContain(fact);

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
  // The same seed check returns the record from its own folder, and refuses another.
  expect(
    parsed(await check({ task: passing, stage: "seed", directory })).witness,
  ).toEqual(seed.witness);
  const elsewhere = `${directory}-elsewhere`;
  expect(
    parseMcpToolError(
      await check({ task: passing, stage: "seed", directory: elsewhere }),
    ).error.message,
  ).toContain(`saved to ${directory}, not ${elsewhere}`);
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

it("asks for the recording a lost start reply began again under its request id when the seed is retried", async () => {
  const witness = await witnessed(0, { lostRecordingStarts: 1 });
  const { check, directory, computer } = witness;
  const lost = await check({ stage: "seed", directory });
  expect(parseMcpToolError(lost).error.message).toContain("recording");
  const seed = parsed(await check({ stage: "seed", directory }));
  expect(seed.witness).toMatchObject({ held: true, next_stage: "after_edit" });
  const starts = computer.recordingRequests.filter(({ path }) =>
    path.endsWith("/start"),
  );
  expect(starts).toHaveLength(2);
  expect(starts[1]?.body).toEqual(starts[0]?.body);
});

it("files no seed or near miss whose only failing check could not read its file, and takes it once the file reads", async () => {
  const witness = await witnessed();
  const { app, check, directory, computer } = witness;
  const locked = {
    "Documents/today.txt": {
      format: null,
      view: null,
      error: "database is locked",
    },
  };
  app.state = locked;
  const unread = ["Documents/today.txt", "database is locked"];
  expectUndecided(await check({ stage: "seed", directory }), "seed", unread);
  app.state = lines("milk");
  expect(
    parsed(await check({ stage: "seed", directory })).witness,
  ).toMatchObject({ stage: "seed", held: true });
  await edit(witness, lines("milk", "eggs"));
  await check({ stage: "after_edit" });
  await edit(witness, locked);
  expectUndecided(await check({ stage: "near_miss" }), "near_miss", unread);
  app.state = lines("milk", "egg");
  const nearMiss = parsed(await check({ stage: "near_miss" }));
  expect(nearMiss.witness).toMatchObject({
    stage: "near_miss",
    held: true,
    next_stage: "after_reset",
  });
  await witness.act("reset");
  const record = parsed(await check({ stage: "after_reset" })).witness?.record;
  expect(record?.stages.map(({ stage }) => stage)).toEqual(WITNESS_ORDER);
  expect(
    computer.recordingRequests.filter(({ path }) => path.endsWith("/start")),
  ).toHaveLength(1);
});

it("files no seed or near miss whose only failing check misses a line its cut view may have left out", async () => {
  const witness = await witnessed();
  const { app, check, directory } = witness;
  const cut = {
    "Documents/today.txt": {
      format: "text",
      view: {
        lines: Array.from(
          { length: 5000 },
          (_, index) => `note ${String(index + 1)}`,
        ),
        line_count: 5001,
        truncated: true,
      },
      truncated: true,
    },
  };
  app.state = cut;
  const missing = ["Documents/today.txt", '"eggs"'];
  expectUndecided(await check({ stage: "seed", directory }), "seed", missing);
  app.state = lines("milk");
  expect(
    parsed(await check({ stage: "seed", directory })).witness,
  ).toMatchObject({ stage: "seed", held: true });
  await edit(witness, lines("milk", "eggs"));
  await check({ stage: "after_edit" });
  await edit(witness, cut);
  expectUndecided(await check({ stage: "near_miss" }), "near_miss", missing);
  app.state = lines("milk", "egg");
  expect(parsed(await check({ stage: "near_miss" })).witness).toMatchObject({
    stage: "near_miss",
    held: true,
    next_stage: "after_reset",
  });
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
  await throughNearMiss(witness);
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
  // Saved, the same check returns the record again without checking or writing; any other is refused.
  expect(parsed(await check({ stage: "after_reset" })).witness).toEqual(
    saved.witness,
  );
  expect(app.methods.length).toBe(gets);
  expect(
    parseMcpToolError(await check({ stage: "near_miss" })).error.message,
  ).toContain("ended");
});

it("returns the record a witness saved when the computer closes while the save commits", async () => {
  const witness = await witnessed();
  const { client, id, check, directory } = witness;
  await throughNearMiss(witness);
  await witness.act("reset");
  let closed: Promise<unknown> = Promise.resolve();
  cancelDuringCommit(() => {
    closed = client.callTool({
      name: "close_build_computer",
      arguments: { computer_id: id },
    });
  });
  const saved = parsed(await check({ stage: "after_reset" }));
  expect(saved.witness?.record).toMatchObject({
    path: join(directory, "witness.json"),
    verdict: "held",
  });
  await closed;
});

it("returns a record saved as its check was cancelled when that check is asked again", async () => {
  const witness = await witnessed();
  const { client, id, directory } = witness;
  await throughNearMiss(witness);
  await witness.act("reset");
  const caller = new AbortController();
  cancelDuringCommit(() => {
    caller.abort();
  });
  await expect(
    client.callTool(
      {
        name: "check_build_task",
        arguments: { computer_id: id, task: TASK, stage: "after_reset" },
      },
      { signal: caller.signal },
    ),
  ).rejects.toThrow();
  const again = parsed(await witness.check({ stage: "after_reset" }));
  expect(again.witness?.record).toMatchObject({
    path: join(directory, "witness.json"),
    verdict: "held",
  });
});

it("files one after_edit when two checks of it arrive together, so the record cannot hold without a near miss", async () => {
  const witness = await witnessed();
  const { check, directory } = witness;
  await check({ stage: "seed", directory });
  await edit(witness, lines("milk", "eggs"));
  const both = await Promise.all([
    check({ stage: "after_edit" }),
    check({ stage: "after_edit" }),
  ]);
  const filed = both.filter((result) => result.isError !== true);
  expect(filed).toHaveLength(1);
  expect(parsed(filed[0])).toMatchObject({
    passed: 1,
    witness: { stage: "after_edit", held: true, next_stage: "near_miss" },
  });
  const second = both.find((result) => result.isError === true);
  expect(parseMcpToolError(second as CallToolResult).error.message).toContain(
    "the next stage is near_miss",
  );
  await witness.act("reset");
  expect(
    parseMcpToolError(await check({ stage: "after_reset" })).error.message,
  ).toContain("the next stage is near_miss");
});

it("checks after_reset once the reset sent before it has relaunched the app", async () => {
  const witness = await witnessed(4);
  const { app, check } = witness;
  await throughNearMiss(witness);
  const order: string[] = [];
  const reset = witness.act("reset").then(() => order.push("reset"));
  await vi.waitFor(() => expect(app.methods.at(-1)).toBe("data/reset"));
  const last = await check({ stage: "after_reset" });
  order.push("check");
  await reset;
  expect(order).toEqual(["reset", "check"]);
  const record = parsed(last).witness?.record;
  expect(record).toMatchObject({ verdict: "held", failed_stage: null });
  expect(record?.stages.at(-1)).toMatchObject({
    stage: "after_reset",
    actions_before: 3,
  });
  expect(record?.actions.at(-1)).toMatchObject({
    action: "reset",
    outcome: "applied",
  });
  expect(app.methods.slice(-2)).toEqual(["data/reset", "data/get"]);
}, 30_000);

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
